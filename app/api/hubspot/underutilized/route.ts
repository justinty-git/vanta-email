import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";

// Force dynamic — see audience-status/route.ts for the full reasoning.
// Without this, Next.js can serve a cached/stale response instead of
// re-querying Postgres on every request.
export const dynamic = "force-dynamic";

// GET /api/hubspot/underutilized
//
// Reads the latest daily snapshot for Global, Prospects, and Customers
// (three separate metric_snapshots rows, same metric_type). Global
// stays at the TOP LEVEL of the response, unchanged shape from before —
// existing frontend code reading totalMarketable/underutilized/
// coveragePct/checkedAt directly keeps working as-is. Prospects/
// Customers are new, returned in a separate byAudienceType array, so
// this is a pure addition, not a breaking change to the existing
// single-stat view.
//
// Per Justin — wanting Underutilized Audience useful to both
// prospect-focused and customer-focused teams, not just one blended
// global number.

const WINDOW_DAYS = 7; // matches computeUnderutilized()'s window in lib/hubspot.ts

export async function GET() {
  try {
    await ensureSchema();
    const db = getPool();

    const result = await db.query(
      `SELECT DISTINCT ON (segment_label) segment_label, total_count, healthy_count, rate, created_at
       FROM metric_snapshots
       WHERE metric_type = 'underutilized'
       ORDER BY segment_label, snapshot_date DESC`
    );

    const byLabel = new Map<string, any>();
    for (const row of result.rows) {
      byLabel.set(row.segment_label, row);
    }

    const globalRow = byLabel.get("Global");
    const globalTotalMarketable = globalRow ? globalRow.total_count : null;
    const globalReached = globalRow ? globalRow.healthy_count : null;
    const globalUnderutilized =
      globalTotalMarketable !== null && globalReached !== null ? globalTotalMarketable - globalReached : null;
    const mostRecentCheckedAt = result.rows.length > 0
      ? result.rows.reduce((latest: string, r: any) => (r.created_at > latest ? r.created_at : latest), result.rows[0].created_at)
      : null;

    const byAudienceType = (["Prospects", "Customers"] as const).map((label) => {
      const row = byLabel.get(label);
      if (!row) return { label, totalMarketable: null, underutilized: null, coveragePct: null, pending: true };
      const totalMarketable = row.total_count;
      const reached = row.healthy_count;
      const underutilized = totalMarketable !== null && reached !== null ? totalMarketable - reached : null;
      return {
        label,
        totalMarketable,
        underutilized,
        coveragePct: row.rate !== null ? Number(row.rate) : null,
        pending: false,
      };
    });

    if (!globalRow) {
      return NextResponse.json({
        status: "ok",
        windowDays: WINDOW_DAYS,
        totalMarketable: null,
        underutilized: null,
        coveragePct: null,
        checkedAt: null,
        pending: true, // no snapshot written yet — cron hasn't run
        byAudienceType,
      }, {
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    return NextResponse.json({
      status: "ok",
      windowDays: WINDOW_DAYS,
      totalMarketable: globalTotalMarketable,
      underutilized: globalUnderutilized,
      coveragePct: globalRow.rate !== null ? Number(globalRow.rate) : null,
      checkedAt: mostRecentCheckedAt,
      byAudienceType,
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
