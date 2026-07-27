import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";

// GET /api/segment-health-trend
//
// Reads the stored Segment Health time series from Aurora PostgreSQL
// (written daily by app/api/cron/snapshot-metrics). Returns one array
// per segment_label, ordered oldest-to-newest, for charting.
//
// Will return an empty series for any segment until the cron job has
// actually run at least once — this is historical data, not a live
// computation, so there's nothing to show before snapshots accumulate.

const TRAILING_DAYS = 90;

export async function GET() {
  try {
    await ensureSchema();
    const db = getPool();

    const result = await db.query(
      `SELECT segment_label, total_count, healthy_count, rate, snapshot_date
       FROM metric_snapshots
       WHERE metric_type = 'segment_health'
         AND snapshot_date >= (CURRENT_DATE - $1::int)
       ORDER BY segment_label, snapshot_date ASC`,
      [TRAILING_DAYS]
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
      trailingDays: TRAILING_DAYS,
      segments: bySegment,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
