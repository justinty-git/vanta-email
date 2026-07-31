import { NextResponse } from "next/server";
import { SEGMENT_SIZING_CONFIG } from "@/lib/hubspot";
import { ensureSchema, getPool } from "@/lib/db";

// Force dynamic — without this, Next.js can treat a GET route with no
// explicit dynamic-data hints as cacheable and serve a stale response
// instead of re-querying Postgres on every request. Confirmed via a
// real staleness bug: this route was showing a snapshot from a full
// day earlier than what was actually stored, and Vercel's own runtime
// logs showed cache=HIT/STALE annotations on this exact route.
export const dynamic = "force-dynamic";

// GET /api/hubspot/audience-status ("Segment Sizing")
//
// CHANGED: this used to resolve every segment's real size live from
// HubSpot on every page load (2 API calls per segment, every time
// anyone opened the Health tab). Segment sizes only meaningfully move
// day to day — hitting HubSpot live on every load was real,
// unnecessary cost. Now reads the latest daily snapshot already
// written by the cron job (app/api/cron/snapshot-metrics), same
// Postgres table used everywhere else. Still effectively instant on
// page load and still genuinely current.
//
// The UI only ever used `label` (from config) and `size` (resolved) —
// never the HubSpot list's own raw name — so nothing is lost by
// sourcing size from the snapshot instead of a live list-name lookup.

export async function GET() {
  try {
    await ensureSchema();
    const db = getPool();

    const result = await db.query(
      `SELECT DISTINCT ON (segment_label) segment_label, total_count, created_at
       FROM metric_snapshots
       WHERE metric_type = 'segment_sizing'
       ORDER BY segment_label, snapshot_date DESC`
    );

    const sizeByLabel = new Map<string, { size: number | null; checkedAt: string }>();
    for (const row of result.rows) {
      sizeByLabel.set(row.segment_label, { size: row.total_count, checkedAt: row.created_at });
    }

    const segments = SEGMENT_SIZING_CONFIG.map((s: { label: string; group: "region" | "audience"; listId: number }) => {
      const snap = sizeByLabel.get(s.label);
      return {
        label: s.label,
        group: s.group,
        listId: s.listId,
        size: snap ? snap.size : null,
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
