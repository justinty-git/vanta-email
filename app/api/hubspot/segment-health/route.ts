import { NextResponse } from "next/server";
import { SEGMENT_HEALTH_CONFIG } from "@/lib/hubspot";
import { ensureSchema, getPool } from "@/lib/db";

// GET /api/hubspot/segment-health ("Audience Tracking")
//
// CHANGED: this used to compute live from HubSpot on every page load —
// 2 list-size lookups per segment (base + healthy), every single time
// anyone opened the Health tab. Region/Type health rates only
// meaningfully move day to day — hitting HubSpot live on every load was
// real, unnecessary cost, and the odd one out (Underutilized Audience
// and Segment Sizing already made this same move). Now reads the
// latest daily snapshot already written by the cron job
// (app/api/cron/snapshot-metrics), same Postgres table used
// everywhere else. Still effectively instant on page load and still
// genuinely current — updated daily either way.
//
// The trend route (app/api/segment-health-trend) already reads from
// this same table; this is the "right now" counterpart finally using
// the same source instead of a live HubSpot call.

export async function GET() {
  try {
    await ensureSchema();
    const db = getPool();

    const result = await db.query(
      `SELECT DISTINCT ON (segment_label) segment_label, total_count, healthy_count, rate, created_at
       FROM metric_snapshots
       WHERE metric_type = 'segment_health'
       ORDER BY segment_label, snapshot_date DESC`
    );

    const byLabel = new Map<string, { totalCount: number | null; healthyCount: number | null; rate: number | null; checkedAt: string }>();
    for (const row of result.rows) {
      byLabel.set(row.segment_label, {
        totalCount: row.total_count,
        healthyCount: row.healthy_count,
        rate: row.rate !== null ? Number(row.rate) : null,
        checkedAt: row.created_at,
      });
    }

    const segments = SEGMENT_HEALTH_CONFIG.map((s: { label: string; group: "region" | "audience"; baseListId: number; healthyListId: number | null }) => {
      const snap = byLabel.get(s.label);
      return {
        label: s.label,
        group: s.group,
        baseListId: s.baseListId,
        healthyListId: s.healthyListId,
        totalCount: snap ? snap.totalCount : null,
        healthyCount: snap ? snap.healthyCount : null,
        healthRate: snap ? snap.rate : null,
        error: snap ? null : "No snapshot yet",
      };
    });

    const mostRecentCheckedAt = result.rows.length > 0
      ? result.rows.reduce((latest: string, r: any) => (r.created_at > latest ? r.created_at : latest), result.rows[0].created_at)
      : null;

    return NextResponse.json({
      status: "ok",
      segments,
      checkedAt: mostRecentCheckedAt,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
