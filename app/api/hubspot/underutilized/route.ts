import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";

// Force dynamic — see audience-status/route.ts for the full reasoning.
// Without this, Next.js can serve a cached/stale response instead of
// re-querying Postgres on every request.
export const dynamic = "force-dynamic";

// GET /api/hubspot/underutilized
//
// CHANGED: this used to compute live from HubSpot on every page load
// (several search API calls + a list-membership lookup, every single
// time anyone opened the Health tab). Underutilized Audience's number
// only meaningfully changes once a day at most — hitting HubSpot live
// on every load was real, unnecessary cost that would only grow as
// more people have this open. Now reads the latest daily snapshot
// already written by the cron job (app/api/cron/snapshot-metrics),
// same Postgres table used for Region/Audience Tracking's trend
// history. Still effectively instant on page load (a Postgres read,
// not a HubSpot round-trip) and still genuinely current — updated
// daily either way.
//
// "checkedAt" now reflects when the snapshot was actually written
// (the cron's run time), not "just now" — more honest given this is a
// stored snapshot, not a live check.

const WINDOW_DAYS = 7; // matches computeUnderutilized()'s window in lib/hubspot.ts

export async function GET() {
  try {
    await ensureSchema();
    const db = getPool();

    const result = await db.query(
      `SELECT total_count, healthy_count, rate, snapshot_date, created_at
       FROM metric_snapshots
       WHERE metric_type = 'underutilized' AND segment_label = 'Global'
       ORDER BY snapshot_date DESC
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      return NextResponse.json({
        status: "ok",
        windowDays: WINDOW_DAYS,
        totalMarketable: null,
        underutilized: null,
        coveragePct: null,
        checkedAt: null,
        pending: true, // no snapshot written yet — cron hasn't run
      }, {
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    const row = result.rows[0];
    const totalMarketable = row.total_count;
    const reached = row.healthy_count;
    const underutilized = totalMarketable !== null && reached !== null ? totalMarketable - reached : null;

    return NextResponse.json({
      status: "ok",
      windowDays: WINDOW_DAYS,
      totalMarketable,
      underutilized,
      coveragePct: row.rate !== null ? Number(row.rate) : null,
      checkedAt: row.created_at,
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
