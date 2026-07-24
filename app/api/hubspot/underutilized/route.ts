import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/underutilized
//
// "Underutilized Numbers" — how many marketing contacts haven't received
// ANY marketing email in the trailing window, out of the total marketing
// contact database.
//
// This is simpler and cheaper than it first looks: HubSpot already
// tracks hs_email_last_send_date on every contact (auto-maintained,
// "the date of the most recent delivery for any marketing email to the
// current email address" — confirmed via HubSpot's own property
// description). So this is a single CRM search with a date filter, not
// expensive per-send list-membership math.
//
// Scoped to hs_marketable_status = true (real marketing contacts only)
// — the raw database includes sales-only/non-marketing records that
// were never supposed to get emails, and including them would make the
// "underutilized" number meaningless.
//
// "No email yet" contacts (hs_email_last_send_date never set) are
// counted as underutilized too, via a separate OR'd filter group — a
// plain LT filter on a date property does not match contacts where that
// property was never set.
//
// This is a "right now" snapshot only — no history is stored. If a
// trend view is wanted later, this same query just needs to run on a
// schedule (Vercel Cron) with results written somewhere persistent
// (Vercel KV), which doesn't exist yet.

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

export async function GET() {
  try {
    const cutoffMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const marketableFilter = { propertyName: "hs_marketable_status", operator: "EQ", value: "true" };

    const [totalMarketable, underutilized] = await Promise.all([
      searchContactCount([{ filters: [marketableFilter] }]),
      searchContactCount([
        // Sent before the cutoff...
        {
          filters: [
            marketableFilter,
            { propertyName: "hs_email_last_send_date", operator: "LT", value: String(cutoffMs) },
          ],
        },
        // ...OR never sent anything at all.
        {
          filters: [
            marketableFilter,
            { propertyName: "hs_email_last_send_date", operator: "NOT_HAS_PROPERTY" },
          ],
        },
      ]),
    ]);

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
