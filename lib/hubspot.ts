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
