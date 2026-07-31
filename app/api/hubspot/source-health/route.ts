import { NextResponse } from "next/server";
import { SOURCE_VALUES } from "@/lib/hubspot";
import { ensureSchema, getPool } from "@/lib/db";

// Force dynamic — see audience-status/route.ts for the full reasoning.
// Without this, Next.js can serve a cached/stale response instead of
// re-querying Postgres on every request.
export const dynamic = "force-dynamic";

// GET /api/hubspot/source-health
//
// Reads the latest daily snapshot for each hs_analytics_source value —
// written by the cron job (app/api/cron/snapshot-metrics), same
// pattern as every other panel in this app. Built as a Postgres-read
// from day one (not live-on-page-load), since the whole point of this
// session's work was learning not to hit HubSpot live for things that
// don't change within a day.

export async function GET() {
  try {
    await ensureSchema();
    const db = getPool();

    const result = await db.query(
      `SELECT DISTINCT ON (segment_label) segment_label, total_count, healthy_count, rate, created_at
       FROM metric_snapshots
       WHERE metric_type = 'source_health'
       ORDER BY segment_label, snapshot_date DESC`
    );

    const byLabel = new Map<string, { totalCount: number; healthyCount: number; rate: number | null; checkedAt: string }>();
    for (const row of result.rows) {
      byLabel.set(row.segment_label, {
        totalCount: row.total_count,
        healthyCount: row.healthy_count,
        rate: row.rate !== null ? Number(row.rate) : null,
        checkedAt: row.created_at,
      });
    }

    const sources = SOURCE_VALUES.map((s: { value: string; label: string }) => {
      const snap = byLabel.get(s.label);
      return {
        label: s.label,
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
      sources,
      checkedAt: mostRecentCheckedAt,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
