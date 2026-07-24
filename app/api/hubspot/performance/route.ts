import { NextResponse } from "next/server";
import { hubspotFetch, fetchMarketingEmailsPaginated, classifyEmailState } from "@/lib/hubspot";

// GET /api/hubspot/performance
//
// HubSpot-only replacement for the Snowflake-labeled CTOR Trend + Top5/
// Bottom5 Performance Report panels. Everything here is derived from real
// per-email post-send stats — no Snowflake dependency.
//
// Definitions:
// - CTOR (click-to-open rate) = clicks / opens. This is the standard
//   "of the people who opened, how many clicked" metric — different from
//   click rate (clicks / delivered), which the rest of this app already
//   surfaces elsewhere.
// - Weekly trend buckets are calendar weeks (Mon–Sun), aggregated across
//   every send in that week: weekCTOR = sum(clicks) / sum(opens) for all
//   sends whose publishDate falls in that week. This avoids a single
//   low-volume send skewing a week's number the way an unweighted average
//   of per-email CTORs would.
// - Avg CTOR (30d) and Unsub rate (30d) are the same aggregate-not-average
//   approach over the trailing 30 days.
// - Top 5 / Bottom 5 rank INDIVIDUAL sends by their own CTOR, but only
//   among sends with at least MIN_OPENS_FOR_RANKING opens — otherwise a
//   send with 3 opens and 2 clicks (66% CTOR) would crowd out real
//   high-volume winners/losers with a statistically meaningless ratio.
//
// Scope/cost note: this pulls per-email stats for up to MAX_EMAILS_SCANNED
// recent sends (one API call each, sequential — same rate-limit reasoning
// as the other routes in this app). That bounds both HubSpot API load and
// this endpoint's execution time. If your send volume is high enough that
// 8 full weeks exceeds that cap, older weeks in the trend will be based on
// fewer sends than they should be — WINDOW_DAYS/MAX_EMAILS_SCANNED below
// are the knobs to widen this later.
//
// NOT covered here: "Active workflows" KPI needs the Workflows/Automation
// API (a different HubSpot resource entirely) — that's Workflow Watchdog's
// job, not this route's. Left as-is until that's built.

const WINDOW_DAYS = 56; // 8 weeks
const MAX_EMAILS_SCANNED = 60;
const MIN_OPENS_FOR_RANKING = 20; // avoid noisy ratios from tiny sends
const TRAILING_30D_DAYS = 30;

type EmailSummary = { id: string; name: string; publishDate: string };
type Metrics = {
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  unsubscribed: number;
};

async function fetchMetrics(emailId: string): Promise<Metrics> {
  const startTimestamp = new Date("2021-01-01").toISOString();
  const endTimestamp = new Date().toISOString();
  const data = await hubspotFetch(
    `/marketing/v3/emails/statistics/list?emailIds=${encodeURIComponent(
      emailId
    )}&startTimestamp=${encodeURIComponent(
      startTimestamp
    )}&endTimestamp=${encodeURIComponent(endTimestamp)}`
  );
  const counters = data.aggregate?.counters || {};
  const sent = counters.sent ?? 0;
  return {
    sent,
    delivered: counters.delivered ?? counters.deliveries ?? sent,
    opens: counters.open ?? 0,
    clicks: counters.click ?? 0,
    unsubscribed: counters.unsubscribed ?? 0,
  };
}

// Monday-start week key, e.g. "2026-07-20"
function weekKey(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getUTCDay(); // 0 = Sun
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

export async function GET() {
  try {
    const now = Date.now();
    const windowStart = now - WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const rawEmails = await fetchMarketingEmailsPaginated(3);
    const distinctStatesSeen = Array.from(
      new Set(rawEmails.map((e: any) => e.state).filter(Boolean))
    );

    const allEmails: EmailSummary[] = rawEmails
      .filter((e: any) => classifyEmailState(e.state) === "sent" && !!e.publishDate)
      .sort(
        (a: any, b: any) =>
          new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime()
      )
      .map((e: any) => ({ id: e.id, name: e.name, publishDate: e.publishDate }));

    const inWindow = allEmails.filter(
      (e) => new Date(e.publishDate).getTime() >= windowStart
    );
    const scanned = inWindow.slice(0, MAX_EMAILS_SCANNED);
    const truncated = inWindow.length > scanned.length;

    const metricsByEmail = new Map<string, Metrics>();
    for (const e of scanned) {
      try {
        metricsByEmail.set(e.id, await fetchMetrics(e.id));
      } catch {
        // Skip individual failures rather than failing the whole panel.
      }
    }

    // --- Weekly CTOR trend ---
    const weekTotals = new Map<string, { clicks: number; opens: number }>();
    for (const e of scanned) {
      const m = metricsByEmail.get(e.id);
      if (!m) continue;
      const key = weekKey(e.publishDate);
      const cur = weekTotals.get(key) || { clicks: 0, opens: 0 };
      cur.clicks += m.clicks;
      cur.opens += m.opens;
      weekTotals.set(key, cur);
    }
    const trend = Array.from(weekTotals.entries())
      .map(([week, t]) => ({
        week,
        ctor: t.opens > 0 ? t.clicks / t.opens : null,
        opens: t.opens,
        clicks: t.clicks,
      }))
      .sort((a, b) => (a.week < b.week ? -1 : 1));

    // --- Trailing 30-day aggregates ---
    const thirtyDayStart = now - TRAILING_30D_DAYS * 24 * 60 * 60 * 1000;
    const in30d = scanned.filter(
      (e) => new Date(e.publishDate).getTime() >= thirtyDayStart
    );
    let clicks30 = 0,
      opens30 = 0,
      unsub30 = 0,
      delivered30 = 0;
    for (const e of in30d) {
      const m = metricsByEmail.get(e.id);
      if (!m) continue;
      clicks30 += m.clicks;
      opens30 += m.opens;
      unsub30 += m.unsubscribed;
      delivered30 += m.delivered;
    }
    const avgCtor30d = opens30 > 0 ? clicks30 / opens30 : null;
    const unsubRate30d = delivered30 > 0 ? unsub30 / delivered30 : null;

    // --- Top 5 / Bottom 5 by individual CTOR ---
    const ranked = scanned
      .map((e) => {
        const m = metricsByEmail.get(e.id);
        if (!m || m.opens < MIN_OPENS_FOR_RANKING) return null;
        return { id: e.id, name: e.name, publishDate: e.publishDate, ctor: m.clicks / m.opens, opens: m.opens };
      })
      .filter((x): x is { id: string; name: string; publishDate: string; ctor: number; opens: number } => x !== null);

    const top5 = [...ranked].sort((a, b) => b.ctor - a.ctor).slice(0, 5);
    const bottom5 = [...ranked].sort((a, b) => a.ctor - b.ctor).slice(0, 5);

    return NextResponse.json({
      status: "ok",
      windowDays: WINDOW_DAYS,
      scannedCount: scanned.length,
      totalEmailsFetched: rawEmails.length,
      totalSentClassified: allEmails.length,
      distinctStatesSeen,
      truncated,
      rankedCount: ranked.length,
      minOpensForRanking: MIN_OPENS_FOR_RANKING,
      trend,
      avgCtor30d,
      unsubRate30d,
      top5,
      bottom5,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
