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
// Config-driven: SEGMENTS is a list of { label, group, baseListId,
// healthyListId } triples. Adding a new region/segment is a config row,
// not new code. group distinguishes REGIONS (Global/NAMER/EMEA/APAC/
// Other) from AUDIENCE TYPES (Prospects/Customers) — Justin flagged
// that Prospects/Customers aren't regions and shouldn't be lumped into
// the same panel, so the UI splits into two separate panel pairs based
// on this tag rather than duplicating the list-lookup logic per group.
//
// Global: base 31135, healthy 30565 — confirmed directly by Justin.
// Other: base 31137 (revised filters), healthy 31136.
// Prospects: base 26647, healthy 31139 — verified healthy<base (9.9%).
// Customers: base 17717, healthy 31140 — verified healthy<base (52.7%).
export const SEGMENT_HEALTH_CONFIG: Array<{
  label: string;
  group: "region" | "audience";
  baseListId: number;
  healthyListId: number | null;
}> = [
  { label: "Global", group: "region", baseListId: 31135, healthyListId: 30565 },
  { label: "NAMER", group: "region", baseListId: 10077, healthyListId: 31109 },
  { label: "EMEA", group: "region", baseListId: 15048, healthyListId: 31133 },
  { label: "APAC", group: "region", baseListId: 10193, healthyListId: 31134 },
  { label: "Other", group: "region", baseListId: 31137, healthyListId: 31136 },
  { label: "Prospects", group: "audience", baseListId: 26647, healthyListId: 31139 },
  { label: "Customers", group: "audience", baseListId: 17717, healthyListId: 31140 },
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
  group: "region" | "audience";
  baseListId: number;
  healthyListId: number | null;
  totalCount: number | null;
  healthyCount: number | null;
  healthRate: number | null;
  error: string | null;
};

export async function computeSegmentHealth(): Promise<SegmentHealthResult[]> {
  return Promise.all(
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
        group: s.group,
        baseListId: s.baseListId,
        healthyListId: s.healthyListId,
        totalCount: base.size,
        healthyCount: healthy.size,
        healthRate,
        error: base.error || healthy.error,
      };
    })
  );
}


// --- Underutilized Audience ---
// Shared between the daily cron snapshot and (indirectly, via the
// stored snapshot) the live-read route — same compute logic used to
// live here, now runs once a day in the cron instead of on every page
// load. See app/api/hubspot/underutilized/route.ts history for the
// full reasoning on the property-filter/null-handling approach.
const MARKETABLE_LIST_ID = 30565;
const UNDERUTILIZED_WINDOW_DAYS = 7;

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

const marketableFilter = { propertyName: "hs_marketable_status", operator: "EQ", value: "true" };
const noHardBounceFilter = { propertyName: "hs_email_hard_bounce_reason_enum", operator: "NOT_HAS_PROPERTY" };
const notOptedOutFilter = { propertyName: "hs_email_optout", operator: "NOT_HAS_PROPERTY" };

export type UnderutilizedResult = {
  windowDays: number;
  totalMarketable: number;
  underutilized: number;
  coveragePct: number | null;
};

export async function computeUnderutilized(): Promise<UnderutilizedResult> {
  const cutoffMs = Date.now() - UNDERUTILIZED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const commonFilters = [marketableFilter, noHardBounceFilter, notOptedOutFilter];

  const underutilizedBounceUnder3Promise = searchContactCount([
    { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "LT", value: "3" }, { propertyName: "hs_email_last_send_date", operator: "LT", value: String(cutoffMs) }] },
    { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "LT", value: "3" }, { propertyName: "hs_email_last_send_date", operator: "NOT_HAS_PROPERTY" }] },
  ]);
  const underutilizedBounceUnsetPromise = searchContactCount([
    { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "NOT_HAS_PROPERTY" }, { propertyName: "hs_email_last_send_date", operator: "LT", value: String(cutoffMs) }] },
    { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "NOT_HAS_PROPERTY" }, { propertyName: "hs_email_last_send_date", operator: "NOT_HAS_PROPERTY" }] },
  ]);
  const totalMarketablePromise = hubspotFetch(`/crm/v3/lists/${MARKETABLE_LIST_ID}/memberships?limit=1`)
    .then((d: any) => (typeof d.total === "number" ? d.total : 0));

  const [totalMarketable, underutilizedA, underutilizedB] = await Promise.all([
    totalMarketablePromise,
    underutilizedBounceUnder3Promise,
    underutilizedBounceUnsetPromise,
  ]);
  const underutilized = underutilizedA + underutilizedB;
  const coveragePct = totalMarketable > 0 ? 1 - underutilized / totalMarketable : null;

  return { windowDays: UNDERUTILIZED_WINDOW_DAYS, totalMarketable, underutilized, coveragePct };
}

// --- Segment Sizing ---
// Same SEGMENTS list used for the live view and the daily snapshot.
export const SEGMENT_SIZING_CONFIG: Array<{ label: string; group: "region" | "audience"; listId: number }> = [
  { label: "Global", group: "region", listId: 30565 },
  { label: "NAMER", group: "region", listId: 31109 },
  { label: "EMEA", group: "region", listId: 31133 },
  { label: "APAC", group: "region", listId: 31134 },
  { label: "Other", group: "region", listId: 31136 },
  { label: "Prospects", group: "audience", listId: 31139 },
  { label: "Customers", group: "audience", listId: 31140 },
];

export type SegmentSizingResult = {
  label: string;
  group: "region" | "audience";
  listId: number;
  name: string | null;
  size: number | null;
  error: string | null;
};

async function resolveSegmentSizing(listId: number): Promise<{ name: string | null; size: number | null; error: string | null }> {
  try {
    const [listData, membershipsData] = await Promise.all([
      hubspotFetch(`/crm/v3/lists/${listId}`),
      hubspotFetch(`/crm/v3/lists/${listId}/memberships?limit=1`),
    ]);
    const list = listData.list ?? listData;
    return {
      name: list.name || null,
      size: typeof membershipsData.total === "number" ? membershipsData.total : null,
      error: null,
    };
  } catch (error) {
    return { name: null, size: null, error: (error as Error).message };
  }
}

export async function computeSegmentSizing(): Promise<SegmentSizingResult[]> {
  return Promise.all(
    SEGMENT_SIZING_CONFIG.map(async (s) => {
      const r = await resolveSegmentSizing(s.listId);
      return { label: s.label, group: s.group, listId: s.listId, ...r };
    })
  );
}
