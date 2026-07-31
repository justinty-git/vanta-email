import { NextResponse } from "next/server";
import { computeSegmentHealth, computeUnderutilized, computeSegmentSizing, computeSourceHealth, computeFatigue } from "@/lib/hubspot";
import { ensureSchema, getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/cron/snapshot-metrics
//
// Runs twice daily via Vercel Cron (see vercel.json — 10AM and 10PM
// Eastern, currently EDT/UTC-4; cron times are fixed UTC and don't
// auto-adjust for daylight saving, so this will need a one-hour nudge
// when DST changes in November). Writes one row per
// tracked metric into metric_snapshots (Aurora PostgreSQL) — this is
// what turns "right now" panels into an actual trend over time, and
// (as of this version) also what the 3 slow-moving Health panels read
// from instead of hitting HubSpot live on every page load.
//
// Three metric types now, all sharing the same generic table:
// - 'segment_health' (Region Tracking / Audience Tracking) — existing
// - 'underutilized' (Underutilized Audience) — new
// - 'segment_sizing' (Segment Sizing) — new
//
// Reuses the exact same compute functions the live routes used to call
// directly — computeSegmentHealth(), computeUnderutilized(),
// computeSegmentSizing() all live in lib/hubspot.ts, so the stored
// snapshot and what the old live-HubSpot call would have returned can
// never silently diverge.
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

async function upsertSnapshot(
  db: any,
  metricType: string,
  label: string,
  totalCount: number,
  healthyCount: number | null,
  rate: number | null,
  snapshotDate: string
) {
  await db.query(
    `INSERT INTO metric_snapshots (metric_type, segment_label, total_count, healthy_count, rate, snapshot_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (metric_type, segment_label, snapshot_date)
     DO UPDATE SET total_count = EXCLUDED.total_count, healthy_count = EXCLUDED.healthy_count, rate = EXCLUDED.rate, created_at = NOW()`,
    [metricType, label, totalCount, healthyCount, rate, snapshotDate]
  );
}

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
    const db = getPool();
    const snapshotDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const written: string[] = [];
    const skipped: string[] = [];

    // Segment Health (Region Tracking / Audience Tracking) — existing.
    const segments = await computeSegmentHealth();
    for (const s of segments) {
      if (s.totalCount === null || s.healthyCount === null) {
        skipped.push(`segment_health:${s.label}` + (s.error ? ` (${s.error})` : " (missing data)"));
        continue;
      }
      await upsertSnapshot(db, "segment_health", s.label, s.totalCount, s.healthyCount, s.healthRate, snapshotDate);
      written.push(`segment_health:${s.label}`);
    }

    // Underutilized Audience — new. Single row; "healthy_count" here
    // means "reached" (the complement of underutilized), matching the
    // same total/healthy/rate shape as every other metric in this table.
    try {
      const u = await computeUnderutilized();
      const reached = u.totalMarketable - u.underutilized;
      await upsertSnapshot(db, "underutilized", "Global", u.totalMarketable, reached, u.coveragePct, snapshotDate);
      written.push("underutilized:Global");
    } catch (error) {
      skipped.push(`underutilized:Global (${(error as Error).message})`);
    }

    // Segment Sizing — new. One row per segment; no healthy/rate
    // concept here (it's a raw size list), so those columns stay null.
    const sizingSegments = await computeSegmentSizing();
    for (const s of sizingSegments) {
      if (s.size === null) {
        skipped.push(`segment_sizing:${s.label}` + (s.error ? ` (${s.error})` : " (missing data)"));
        continue;
      }
      await upsertSnapshot(db, "segment_sizing", s.label, s.size, null, null, snapshotDate);
      written.push(`segment_sizing:${s.label}`);
    }

    // Source Health — new. One row per hs_analytics_source value.
    const sourceHealthResults = await computeSourceHealth();
    for (const s of sourceHealthResults) {
      if (s.totalCount === null || s.healthyCount === null) {
        skipped.push(`source_health:${s.label}` + (s.error ? ` (${s.error})` : " (missing data)"));
        continue;
      }
      await upsertSnapshot(db, "source_health", s.label, s.totalCount, s.healthyCount, s.healthRate, snapshotDate);
      written.push(`source_health:${s.label}`);
    }

    // Fatigue — new. Single row; "healthy_count" here means "NOT
    // fatigued" (the complement), matching the same total/healthy/rate
    // shape as every other metric in this table.
    try {
      const f = await computeFatigue();
      if (f.totalMarketable === null || f.fatigued === null) {
        skipped.push("fatigue:Global" + (f.error ? ` (${f.error})` : " (missing data)"));
      } else {
        const notFatigued = f.totalMarketable - f.fatigued;
        const notFatiguedRate = f.totalMarketable > 0 ? notFatigued / f.totalMarketable : null;
        await upsertSnapshot(db, "fatigue", "Global", f.totalMarketable, notFatigued, notFatiguedRate, snapshotDate);
        written.push("fatigue:Global");
      }
    } catch (error) {
      skipped.push(`fatigue:Global (${(error as Error).message})`);
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
