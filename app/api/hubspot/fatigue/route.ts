import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";

// Force dynamic — see audience-status/route.ts for the full reasoning.
// Without this, Next.js can serve a cached/stale response instead of
// re-querying Postgres on every request.
export const dynamic = "force-dynamic";

// GET /api/hubspot/fatigue
//
// Reads the latest daily "fatigue" snapshots for Global, Prospects, and
// Customers — the mirror image of Underutilized Audience, same
// Prospects/Customers split added for the same reason (useful to both
// audience-focused teams, not just one blended number). Global stays
// at the top level, unchanged shape from before; Prospects/Customers
// are new, in a separate byAudienceType array — pure addition, not a
// breaking change.

const FATIGUE_THRESHOLD = 10;

export async function GET() {
  try {
    await ensureSchema();
    const db = getPool();

    const result = await db.query(
      `SELECT DISTINCT ON (segment_label) segment_label, total_count, healthy_count, rate, created_at
       FROM metric_snapshots
       WHERE metric_type = 'fatigue'
       ORDER BY segment_label, snapshot_date DESC`
    );

    const byLabel = new Map<string, any>();
    for (const row of result.rows) {
      byLabel.set(row.segment_label, row);
    }

    const globalRow = byLabel.get("Global");
    const mostRecentCheckedAt = result.rows.length > 0
      ? result.rows.reduce((latest: string, r: any) => (r.created_at > latest ? r.created_at : latest), result.rows[0].created_at)
      : null;

    const byAudienceType = (["Prospects", "Customers"] as const).map((label) => {
      const row = byLabel.get(label);
      if (!row) return { label, totalMarketable: null, fatigued: null, fatiguedPct: null, pending: true };
      const totalMarketable = row.total_count;
      const notFatigued = row.healthy_count;
      const fatigued = totalMarketable !== null && notFatigued !== null ? totalMarketable - notFatigued : null;
      return {
        label,
        totalMarketable,
        fatigued,
        fatiguedPct: row.rate !== null ? 1 - Number(row.rate) : null,
        pending: false,
      };
    });

    if (!globalRow) {
      return NextResponse.json({
        status: "ok",
        threshold: FATIGUE_THRESHOLD,
        totalMarketable: null,
        fatigued: null,
        fatiguedPct: null,
        checkedAt: null,
        pending: true,
        byAudienceType,
      }, {
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    const totalMarketable = globalRow.total_count;
    const notFatigued = globalRow.healthy_count;
    const fatigued = totalMarketable !== null && notFatigued !== null ? totalMarketable - notFatigued : null;
    const fatiguedPct = globalRow.rate !== null ? 1 - Number(globalRow.rate) : null;

    return NextResponse.json({
      status: "ok",
      threshold: FATIGUE_THRESHOLD,
      totalMarketable,
      fatigued,
      fatiguedPct,
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
