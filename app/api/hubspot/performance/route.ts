import { NextResponse } from "next/server";
import { hubspotFetch, fetchMarketingEmailsPaginated, classifyEmailState } from "@/lib/hubspot";

// GET /api/hubspot/performance
//
// HubSpot-only replacement for the Snowflake-labeled CTOR Trend + Top5/
// Bottom5 Performance Report panels.
//
// Top 5 / Bottom 5 ranks by CLICK RATE (clicks / delivered) across all
// sends, blended — no audience segmentation. This is intentionally a
// quick pointer, not a parallel analysis: the "Full report" link next to
// it is where the real depth (segment breakdowns, historical benchmark
// bands, written interpretation) lives. Click rate matches the ranking
// metric used in that reference report; CTOR is still computed and
// available per email for context.
//
// Definitions:
// - Click rate = clicks / delivered — the ranking key.
// - CTOR (click-to-open rate) = clicks / opens — shown per email for
//   context, not used to rank.
// - Weekly trend buckets are calendar weeks (Mon–Sun), aggregated across
//   every send in that week: weekCTOR = sum(clicks) / sum(opens) for all
//   sends whose publishDate falls in that week.
// - Avg CTOR (30d) and Unsub rate (30d) are the same aggregate approach
//   over the trailing 30 days.
//
// Scope/cost note: this pulls per-email stats for up to MAX_EMAILS_SCANNED
// recent sends (one API call each, sequential). If your send volume is
// high enough that 8 full weeks exceeds that cap, older weeks in the
// trend will be based on fewer sends than they should be.

const WINDOW_DAYS = 56; // 8 weeks
const MAX_EMAILS_SCANNED = 60;
const MIN_DELIVERED_FOR_CLICK_RANKING = 50; // avoid noisy ratios from tiny sends
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

    // --- Top 5 / Bottom 5 by Click Rate, blended across all sends ---
    const ranked = scanned
      .map((e) => {
        const m = metricsByEmail.get(e.id);
        if (!m || m.delivered < MIN_DELIVERED_FOR_CLICK_RANKING) return null;
        return {
          id: e.id,
          name: e.name,
          publishDate: e.publishDate,
          clickRate: m.clicks / m.delivered,
          ctor: m.opens > 0 ? m.clicks / m.opens : null,
        };
      })
      .filter(
        (x): x is { id: string; name: string; publishDate: string; clickRate: number; ctor: number | null } =>
          x !== null
      );

    const top5 = [...ranked].sort((a, b) => b.clickRate - a.clickRate).slice(0, 5);
    const bottom5 = [...ranked].sort((a, b) => a.clickRate - b.clickRate).slice(0, 5);

    return NextResponse.json({
      status: "ok",
      windowDays: WINDOW_DAYS,
      scannedCount: scanned.length,
      totalEmailsFetched: rawEmails.length,
      totalSentClassified: allEmails.length,
      distinctStatesSeen,
      truncated,
      rankedCount: ranked.length,
      minDeliveredForRanking: MIN_DELIVERED_FOR_CLICK_RANKING,
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
