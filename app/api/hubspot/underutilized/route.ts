import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/underutilized
//
// "Underutilized Numbers" — how many marketing contacts haven't received
// ANY marketing email in the trailing window, out of the REAL healthy
// marketing-contact population.
//
// UPGRADED denominator: previously just hs_marketable_status = true.
// Justin pointed at a real, curated HubSpot list — "[GLOBAL] Marketing
// Contacts" — as a better source of truth, built from: marketable
// status = true, hard bounce reason unknown (never hard-bounced),
// unsubscribed from all email = false, and marketing emails bounced < 3.
//
// Rather than filter by LIST MEMBERSHIP (confirmed via HubSpot's own
// community forum that the CRM search API can't filter by list
// membership directly — would require pulling every member ID via
// /crm/v3/lists/{id}/memberships and batch-querying them, expensive at
// this account's scale), this replicates the list's underlying FILTER
// LOGIC as direct property filters on the same cheap aggregate-count
// query already in use. Same result, far cheaper.
//
// Real property names (verified, not guessed):
// - hs_marketable_status (bool)
// - hs_email_hard_bounce_reason_enum (enum) — "is unknown" = never set
// - hs_email_optout (bool) — "Unsubscribed from all email"
// - hs_email_bounce (number) — "Marketing emails bounced"
//
// NULL-HANDLING, the recurring trap in this account: HubSpot only WRITES
// hs_email_bounce and hs_email_optout when something notable happens
// (a bounce occurs, someone unsubscribes) — they're left completely
// UNSET for the healthy majority, not explicitly "false"/"0". Verified
// directly: hs_email_optout is NEVER explicitly "false" in this account
// (that branch returns 0 total) — only ever "true" (real unsubscribes)
// or unset. So "not unsubscribed" only needs NOT_HAS_PROPERTY, no OR
// needed. hs_email_bounce DOES need an OR branch (both real values <3
// and completely-unset contacts both count as "healthy").
//
// Verified live against real data before shipping: the refined
// population comes to 362,260 (vs. 412,547 raw hs_marketable_status),
// consistent with excluding real hard-bounced/high-bounce contacts.
//
// HubSpot's search API caps at 18 filters total across all filterGroups
// — the full cross-product of every OR'd condition doesn't fit in one
// call, hence the split into multiple calls below, summed client-side
// (safe since each call represents a mutually-exclusive slice).

const WINDOW_DAYS = 7;

async function searchContactCount(filterGroups: any[]): Promise<number> {
  const data = await hubspotFetch("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups,
      limit: 1, // we only need the `total` count, not the records
      properties: ["hs_object_id"],
    }),
  });
  return data.total ?? 0;
}

const marketableFilter = { propertyName: "hs_marketable_status", operator: "EQ", value: "true" };
const noHardBounceFilter = { propertyName: "hs_email_hard_bounce_reason_enum", operator: "NOT_HAS_PROPERTY" };
const notOptedOutFilter = { propertyName: "hs_email_optout", operator: "NOT_HAS_PROPERTY" };

export async function GET() {
  try {
    const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const commonFilters = [marketableFilter, noHardBounceFilter, notOptedOutFilter];

    // Total refined population: 2 groups (bounce<3 OR bounce-unset), 8
    // filters total, well under the 18 cap.
    const totalMarketablePromise = searchContactCount([
      { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "LT", value: "3" }] },
      { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "NOT_HAS_PROPERTY" }] },
    ]);

    // Underutilized subset of that same population: split into 2 calls
    // (one per bounce branch), each internally OR'ing the send-date
    // branch (2 groups x 5 filters = 10 filters per call), summed.
    const underutilizedBounceUnder3Promise = searchContactCount([
      { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "LT", value: "3" }, { propertyName: "hs_email_last_send_date", operator: "LT", value: String(cutoffMs) }] },
      { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "LT", value: "3" }, { propertyName: "hs_email_last_send_date", operator: "NOT_HAS_PROPERTY" }] },
    ]);
    const underutilizedBounceUnsetPromise = searchContactCount([
      { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "NOT_HAS_PROPERTY" }, { propertyName: "hs_email_last_send_date", operator: "LT", value: String(cutoffMs) }] },
      { filters: [...commonFilters, { propertyName: "hs_email_bounce", operator: "NOT_HAS_PROPERTY" }, { propertyName: "hs_email_last_send_date", operator: "NOT_HAS_PROPERTY" }] },
    ]);

    const [totalMarketable, underutilizedA, underutilizedB] = await Promise.all([
      totalMarketablePromise,
      underutilizedBounceUnder3Promise,
      underutilizedBounceUnsetPromise,
    ]);
    const underutilized = underutilizedA + underutilizedB;

    const coveragePct = totalMarketable > 0 ? 1 - underutilized / totalMarketable : null;

    return NextResponse.json({
      status: "ok",
      windowDays: WINDOW_DAYS,
      totalMarketable,
      underutilized,
      coveragePct,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
