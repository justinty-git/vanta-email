import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/underutilized
//
// "Underutilized Numbers" — how many marketing contacts haven't
// received ANY marketing email in the trailing window, out of the
// REAL "[GLOBAL] Marketing Contacts" population (HubSpot list 30565).
//
// SIMPLIFIED: previously computed the total population by replicating
// the list's filter logic as property filters (marketable + no hard
// bounce + not opted out + bounce<3), then separately validated that
// against the list's own real size. Justin asked for this to just
// check against the real list directly instead — simpler to explain,
// and the list is the actual source of truth rather than a
// reconstruction of it. Total is now the list's own real size
// (GET /crm/v3/lists/30565/memberships), one cheap call.
//
// The "no email in 7 days" breakdown still needs property-based date
// filtering (no way to combine list membership with a date filter
// cheaply — confirmed earlier that HubSpot's search API can't filter
// by list membership at all), so that part still uses the equivalent
// healthy-contact criteria the list itself is built from. Real property
// names (verified, not guessed): hs_marketable_status,
// hs_email_hard_bounce_reason_enum, hs_email_optout, hs_email_bounce.
//
// NULL-HANDLING: hs_email_bounce and hs_email_optout are only written
// when something notable happens (a bounce, an unsubscribe) — left
// completely unset for the healthy majority. Confirmed hs_email_optout
// is never explicitly "false" in this account, so "not unsubscribed"
// only needs NOT_HAS_PROPERTY. hs_email_bounce needs an OR (real
// values <3 AND unset both count as healthy).
//
// HubSpot's search API caps at 18 filters total across all
// filterGroups — hence the split into 2 calls below (one per bounce
// branch), summed client-side.

const MARKETABLE_LIST_ID = 30565;
const WINDOW_DAYS = 7;

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

export async function GET() {
  try {
    const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
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
