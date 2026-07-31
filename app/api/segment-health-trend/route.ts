import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";

// Force dynamic — see app/api/hubspot/audience-status/route.ts for the
// full reasoning. Without this, Next.js can serve a cached/stale
// response instead of re-querying Postgres on every request.
export const dynamic = "force-dynamic";
// GET /api/segment-health-trend?metricType=segment_health|underutilized
//
// Reads a stored metric's time series from Aurora PostgreSQL (written
// daily by app/api/cron/snapshot-metrics). Returns one array per
// segment_label, ordered oldest-to-newest, for charting.
//
// Generalized from segment_health-only to accept any metric_type via
// query param (defaults to 'segment_health' — existing callers with no
// param keep working unchanged) so Underutilized Audience's new daily
// snapshots (added alongside this) can reuse the exact same read logic
// instead of a duplicated route.
//
// Will return an empty series for any segment until the cron job has
// actually run at least once — this is historical data, not a live
// computation, so there's nothing to show before snapshots accumulate.

const TRAILING_DAYS = 90;

export async function GET(request: Request) {
  try {
    await ensureSchema();
    const db = getPool();
    const { searchParams } = new URL(request.url);
    const metricType = searchParams.get("metricType") || "segment_health";

    const result = await db.query(
      `SELECT segment_label, total_count, healthy_count, rate, snapshot_date
       FROM metric_snapshots
       WHERE metric_type = $1
         AND snapshot_date >= (CURRENT_DATE - $2::int)
       ORDER BY segment_label, snapshot_date ASC`,
      [metricType, TRAILING_DAYS]
    );

    const bySegment: Record<
      string,
      Array<{ date: string; totalCount: number; healthyCount: number; rate: number | null }>
    > = {};

    for (const row of result.rows) {
      const label = row.segment_label as string;
      if (!bySegment[label]) bySegment[label] = [];
      bySegment[label].push({
        date: row.snapshot_date.toISOString().slice(0, 10),
        totalCount: row.total_count,
        healthyCount: row.healthy_count,
        rate: row.rate !== null ? Number(row.rate) : null,
      });
    }

    return NextResponse.json({
      status: "ok",
      metricType,
      trailingDays: TRAILING_DAYS,
      segments: bySegment,
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
