import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";

// Force dynamic — see audience-status/route.ts for the full reasoning.
// Without this, Next.js can serve a cached/stale response instead of
// re-querying Postgres on every request.
export const dynamic = "force-dynamic";

// GET /api/hubspot/fatigue
//
// Reads the latest daily "fatigue" snapshot — contacts with more than
// 10 marketing sends since their last open/click
// (hs_email_sends_since_last_engagement), the mirror image of
// Underutilized Audience. Written by the cron job, same pattern as
// every other panel.

const FATIGUE_THRESHOLD = 10;

export async function GET() {
  try {
    await ensureSchema();
    const db = getPool();

    const result = await db.query(
      `SELECT total_count, healthy_count, rate, created_at
       FROM metric_snapshots
       WHERE metric_type = 'fatigue' AND segment_label = 'Global'
       ORDER BY snapshot_date DESC
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      return NextResponse.json({
        status: "ok",
        threshold: FATIGUE_THRESHOLD,
        totalMarketable: null,
        fatigued: null,
        fatiguedPct: null,
        checkedAt: null,
        pending: true,
      }, {
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    const row = result.rows[0];
    const totalMarketable = row.total_count;
    const notFatigued = row.healthy_count;
    const fatigued = totalMarketable !== null && notFatigued !== null ? totalMarketable - notFatigued : null;
    const fatiguedPct = row.rate !== null ? 1 - Number(row.rate) : null; // stored rate is "not fatigued" — invert for display

    return NextResponse.json({
      status: "ok",
      threshold: FATIGUE_THRESHOLD,
      totalMarketable,
      fatigued,
      fatiguedPct,
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
