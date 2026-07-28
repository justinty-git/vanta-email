// Server-side only. Never import this file from a Client Component.
// The token lives in Vercel's Environment Variables (HUBSPOT_TOKEN) —
// it is never sent to the browser.

const HUBSPOT_BASE_URL = "https://api.hubapi.com";

export async function hubspotFetch(path: string, init?: RequestInit) {
  const token = process.env.HUBSPOT_TOKEN;

  if (!token) {
    throw new Error(
      "HUBSPOT_TOKEN is not set. Add it in Vercel → Project Settings → Environment Variables."
    );
  }

  const res = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    // Marketing/workflow data doesn't need to be real-time to the second —
    // cache briefly to avoid hammering HubSpot's API on every page load.
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot API error ${res.status}: ${body}`);
  }

  return res.json();
}

// Classifies a marketing email's `state` field defensively. We could never
// confirm the exact documented enum values for this field (HubSpot's public
// docs don't clearly list them), and separately couldn't confirm whether
// `state=` is even honored as a server-side query filter on
// GET /marketing/v3/emails — one reference implementation of this endpoint
// only supported `limit`/`offset`/`sort` (by name/createdAt/updatedAt), with
// no `state` filter and no `publishDate` sort option at all.
//
// Rather than filter server-side on an unverified param, every route in
// this app fetches a batch and classifies client-side here, matching
// multiple plausible spellings/casings for each bucket. If you find the
// real enum values in this account's data (e.g. via the raw email objects
// logged from any of the /api/hubspot/* routes), tighten this up.
export function classifyEmailState(
  state: string | undefined | null
): "sent" | "scheduled" | "draft" | "other" {
  const s = (state || "").toUpperCase();
  if (["SENT", "PUBLISHED", "PUBLISH", "COMPLETE", "COMPLETED"].includes(s))
    return "sent";
  if (
    ["SCHEDULED", "PUBLISHED_OR_SCHEDULED", "PROCESSING", "QUEUED"].includes(s)
  )
    return "scheduled";
  if (["DRAFT", "AB_TEST"].includes(s)) return "draft";
  return "other";
}

// Fetch marketing emails, paginating past the first page since we're not
// relying on a server-side state filter — a bare 100-email page (whatever
// HubSpot's default sort order actually is) may be mostly drafts/old sends
// and miss the actual recent-sent or near-term-scheduled emails we need.
// Sorts by -updatedAt, a documented-safe sort field, as a bias toward
// recently-touched emails rather than trusting an unconfirmed sort option.
export async function fetchMarketingEmailsPaginated(
  maxPages: number = 3
): Promise<any[]> {
  const all: any[] = [];
  let after: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const url =
      `/marketing/v3/emails?limit=100&sort=-updatedAt` +
      (after ? `&after=${encodeURIComponent(after)}` : "");
    const data = await hubspotFetch(url);
    all.push(...(data.results || []));
    after = data.paging?.next?.after;
    if (!after) break;
  }

  return all;
}

// --- Segment Health Tracking ---
// Shared between the live "/api/hubspot/segment-health" route and the
// daily snapshot cron job, so both use identical logic — no risk of the
// live view and the stored history silently drifting apart.
//
// Config-driven: SEGMENTS is a list of { label, baseListId,
// healthyListId } triples. Adding a new region is a config row, not new
// code. Each region has its own base + healthy list pair. Global sits
// on top of the regional breakdown, same shape.
//
// NOTE: healthy(30565)=370,817 vs base(31135)=99,462 looked backwards
// (healthy larger than its own base), which is why this was briefly
// swapped. Reverted per Justin — list 31135 is still processing in
// HubSpot, so that count was likely a partial/incomplete snapshot, not
// a true final size. Worth re-checking both numbers once 31135 finishes
// processing before assuming either direction is correct.
export const SEGMENT_HEALTH_CONFIG: Array<{
  label: string;
  baseListId: number;
  healthyListId: number | null;
}> = [
  { label: "Global", baseListId: 31135, healthyListId: 30565 },
  { label: "NAMER [Region]", baseListId: 10077, healthyListId: 31109 },
  { label: "EMEA [Region]", baseListId: 15048, healthyListId: 31133 },
  { label: "APAC [Region]", baseListId: 10193, healthyListId: 31134 },
];

export async function resolveListSize(
  listId: number | null
): Promise<{ size: number | null; error: string | null }> {
  if (listId === null) return { size: null, error: "List not created yet" };
  try {
    const data = await hubspotFetch(`/crm/v3/lists/${listId}/memberships?limit=1`);
    return { size: typeof data.total === "number" ? data.total : null, error: null };
  } catch (error) {
    return { size: null, error: (error as Error).message };
  }
}

export type SegmentHealthResult = {
  label: string;
  baseListId: number;
  healthyListId: number | null;
  totalCount: number | null;
  healthyCount: number | null;
  healthRate: number | null;
  error: string | null;
};

export async function computeSegmentHealth(): Promise<SegmentHealthResult[]> {
  const regionResults = await Promise.all(
    SEGMENT_HEALTH_CONFIG.map(async (s) => {
      const [base, healthy] = await Promise.all([
        resolveListSize(s.baseListId),
        resolveListSize(s.healthyListId),
      ]);
      const healthRate =
        base.size !== null && base.size > 0 && healthy.size !== null
          ? healthy.size / base.size
          : null;
      return {
        label: s.label,
        baseListId: s.baseListId,
        healthyListId: s.healthyListId,
        totalCount: base.size,
        healthyCount: healthy.size,
        healthRate,
        error: base.error || healthy.error,
      };
    })
  );

  const other = await computeOtherNoLocationSegment();
  return [...regionResults, other];
}

// "Other / No Location" — found via a real investigation: Global's
// healthy count (370,817) was ~84,764 higher than the sum of NAMER +
// EMEA + APAC's healthy counts (286,053). Checked directly against
// HubSpot: 85,393 marketable contacts have no `country` property set at
// all — very close to that gap. Region-based lists filter ON country,
// so contacts missing that field can't land in any of them, but they
// still count toward Global. This surfaces that real data-quality gap
// directly, computed via property filters (not a maintained HubSpot
// list, since "which contacts lack a property" is a query, not
// something worth asking Justin to build and upkeep as a list).
//
// Uses the exact same "healthy" definition already verified for
// Underutilized Audience: marketable = true, never hard-bounced, not
// unsubscribed, <3 bounces (with the same null-vs-explicit-false
// handling already confirmed necessary in this account — hs_email_bounce
// needs an OR'd NOT_HAS_PROPERTY branch since most contacts have it
// completely unset rather than "0").
//
// "Base" here means ALL contacts with no country set (any marketability
// status) — matching how the other regions' base lists work (broad
// population, not pre-filtered to marketable), so the health RATE is
// computed the same way across every row.
async function searchContactCount(filterGroups: any[]): Promise<number> {
  const data = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups,
      limit: 1,
      properties: ["hs_object_id"],
    }),
  });
  return data.total ?? 0;
}

async function computeOtherNoLocationSegment(): Promise<SegmentHealthResult> {
  try {
    const noCountry = { propertyName: "country", operator: "NOT_HAS_PROPERTY" };
    const marketable = { propertyName: "hs_marketable_status", operator: "EQ", value: "true" };
    const noHardBounce = { propertyName: "hs_email_hard_bounce_reason_enum", operator: "NOT_HAS_PROPERTY" };
    const notOptedOut = { propertyName: "hs_email_optout", operator: "NOT_HAS_PROPERTY" };

    const [totalCount, healthyCount] = await Promise.all([
      searchContactCount([{ filters: [noCountry] }]),
      searchContactCount([
        { filters: [noCountry, marketable, noHardBounce, notOptedOut, { propertyName: "hs_email_bounce", operator: "LT", value: "3" }] },
        { filters: [noCountry, marketable, noHardBounce, notOptedOut, { propertyName: "hs_email_bounce", operator: "NOT_HAS_PROPERTY" }] },
      ]),
    ]);

    return {
      label: "Other / No Location",
      baseListId: -1,
      healthyListId: -1,
      totalCount,
      healthyCount,
      healthRate: totalCount > 0 ? healthyCount / totalCount : null,
      error: null,
    };
  } catch (error) {
    return {
      label: "Other / No Location",
      baseListId: -1,
      healthyListId: -1,
      totalCount: null,
      healthyCount: null,
      healthRate: null,
      error: (error as Error).message,
    };
  }
}

