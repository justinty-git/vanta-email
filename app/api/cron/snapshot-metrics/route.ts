import { NextResponse } from "next/server";
import { computeSegmentHealth } from "@/lib/hubspot";
import { ensureSchema, getPool } from "@/lib/db";

// GET /api/cron/snapshot-metrics
//
// Runs daily via Vercel Cron (see vercel.json). Computes today's
// Segment Health for every configured region and writes one row per
// segment into metric_snapshots (Aurora PostgreSQL). This is what turns
// the "right now" Segment Health panel into an actual trend over time —
// nothing charts until snapshots start accumulating here.
//
// Reuses computeSegmentHealth() from lib/hubspot.ts — the exact same
// logic the live "/api/hubspot/segment-health" route uses, so the
// stored history and the live view can never silently diverge.
//
// UPSERT on (metric_type, segment_label, snapshot_date): if the cron
// runs more than once on the same day (manual trigger + scheduled, or
// a retry), this updates that day's row instead of creating a
// duplicate.
//
// Security: if CRON_SECRET is set as an env var, requires the request's
// Authorization header to match — the standard Vercel-recommended way
// to keep this endpoint from being triggered by anyone who finds the
// URL. Not yet configured (no CRON_SECRET set), so this check is
// currently a no-op — added so it's a one-line env var away from being
// locked down, not because it's protecting anything today.

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ status: "error", message: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    await ensureSchema();
    const segments = await computeSegmentHealth();
    const db = getPool();
    const snapshotDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const written: string[] = [];
    const skipped: string[] = [];

    for (const s of segments) {
      if (s.totalCount === null || s.healthyCount === null) {
        skipped.push(s.label + (s.error ? ` (${s.error})` : " (missing data)"));
        continue;
      }
      await db.query(
        `INSERT INTO metric_snapshots (metric_type, segment_label, total_count, healthy_count, rate, snapshot_date)
         VALUES ('segment_health', $1, $2, $3, $4, $5)
         ON CONFLICT (metric_type, segment_label, snapshot_date)
         DO UPDATE SET total_count = EXCLUDED.total_count, healthy_count = EXCLUDED.healthy_count, rate = EXCLUDED.rate`,
        [s.label, s.totalCount, s.healthyCount, s.healthRate, snapshotDate]
      );
      written.push(s.label);
    }

    return NextResponse.json({
      status: "ok",
      snapshotDate,
      written,
      skipped,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
