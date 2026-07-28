import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

// GET /api/admin/clear-segment-health-history
//
// ONE-TIME USE. Clears all stored Segment Health snapshots
// (metric_type = 'segment_health') so trend tracking starts fresh from
// today's corrected SEGMENT_HEALTH_CONFIG.
//
// Why: today's list-ID corrections (Global's base swapped 31135 ->
// 31137 -> back to 31135, Other's base/healthy added and revised)
// happened AFTER at least one snapshot had already been written for
// today. That produced a misleading trend comparison — a region showed
// "+2,178,486 contacts" overnight, which wasn't real audience growth,
// just the underlying list reference changing mid-day. Rather than let
// a contaminated baseline sit in the trend history, wiping it and
// starting clean from here is safer than trying to patch individual
// rows.
//
// Scoped to metric_type = 'segment_health' only — does not touch any
// other metric type that might exist in this same generic table later
// (e.g. an eventual Underutilized Audience trend).
//
// Not meant to be a permanent feature — this is disposable, one-time
// cleanup tooling. Safe to leave in place (idempotent — running it
// again just deletes nothing if the table's already empty), but there's
// no reason to build anything more permanent around it.

export async function GET() {
  try {
    const db = getPool();
    const result = await db.query(
      `DELETE FROM metric_snapshots WHERE metric_type = 'segment_health'`
    );
    return NextResponse.json({
      status: "ok",
      deletedRows: result.rowCount,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
