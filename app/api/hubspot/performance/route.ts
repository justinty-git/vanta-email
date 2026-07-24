import { NextResponse } from "next/server";
import { hubspotFetch, fetchMarketingEmailsPaginated, classifyEmailState } from "@/lib/hubspot";

// GET /api/hubspot/performance
//
// HubSpot-only replacement for the Snowflake-labeled CTOR Trend + Top5/
// Bottom5 Performance Report panels.
//
// METHODOLOGY ALIGNED to Justin's actual June 2026 "Email Performance by
// Segment" report (uploaded reference), which differs from this route's
// original design in two real ways:
// 1. Ranks Top 5 / Bottom 5 by CLICK RATE (clicks / delivered), not CTOR
//    (clicks / opens). CTOR is still computed and shown per email, but
//    it's not the ranking key.
// 2. Segments sends into Prospect / Customer / Mixed Audience and ranks
//    EACH segment separately — a global blended ranking hides real
//    per-segment issues (a weak prospect send can look fine next to a
//    strong customer send). Segment is inferred from the email name,
//    since Justin's naming convention embeds it directly (e.g. "[APAC]
//    FY27 | Webinar | Prospects | GRC Engineering | RC1"). If a name
//    doesn't clearly say "prospect" or "customer", it's treated as Mixed
//    — matching the report's own framing that combined-audience sends
//    aren't comparable to either pure segment.
//
// NOT YET ALIGNED — flagged rather than faked: the reference report's
// benchmark bands (e.g. "Prospect Open Rate Within 27.1–36.9%") come from
// real historical percentile bands across n=427 prospect / n=185 customer
// sends, Feb 2025–July 2026. This route still compares each send only
// against the average of its own current scan window, not a true
// historical baseline — building that properly means pulling a much
// larger historical dataset and agreeing on how the bands are computed
// (percentile cutoffs, min sample size, etc.), which is a bigger,
// separate task from the ranking-metric/segmentation fix here.
//
// Definitions:
// - Click rate = clicks / delivered — the ranking key, matches the
//   reference report.
// - CTOR (click-to-open rate) = clicks / opens — still shown per email
//   for context, just not used to rank.
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
const MIN_OPENS_FOR_RANKING = 20; // avoid noisy ratios from tiny sends
const MIN_DELIVERED_FOR_CLICK_RANKING = 50; // click rate denominator is delivered, not opens
const TRAILING_30D_DAYS = 30;

type EmailSummary = { id: string; name: string; publishDate: string };
type Metrics = {
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  unsubscribed: number;
};
type Segment = "prospect" | "customer" | "mixed";

function classifySegment(name: string): Segment {
  const n = name.toLowerCase();
  const hasCustomer = /\bcustomer(s)?\b/.test(n);
  const hasProspect = /\bprospect(s)?\b/.test(n);
  // Both or neither present -> Mixed, matching the reference report's
  // treatment of combined-audience sends as their own bucket.
  if (hasCustomer && !hasProspect) return "customer";
  if (hasProspect && !hasCustomer) return "prospect";
  return "mixed";
}

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

    // --- Weekly CTOR trend (unchanged — this panel isn't segmented in
    // the reference report) ---
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

    // --- Segmented Top 5 / Bottom 5 by CLICK RATE ---
    type RankedEmail = {
      id: string;
      name: string;
      publishDate: string;
      clickRate: number;
      ctor: number | null;
      openRate: number | null;
      delivered: number;
    };

    const bySegment: Record<Segment, RankedEmail[]> = { prospect: [], customer: [], mixed: [] };
    for (const e of scanned) {
      const m = metricsByEmail.get(e.id);
      if (!m || m.delivered < MIN_DELIVERED_FOR_CLICK_RANKING) continue;
      const segment = classifySegment(e.name);
      bySegment[segment].push({
        id: e.id,
        name: e.name,
        publishDate: e.publishDate,
        clickRate: m.clicks / m.delivered,
        ctor: m.opens > 0 ? m.clicks / m.opens : null,
        openRate: m.delivered > 0 ? m.opens / m.delivered : null,
        delivered: m.delivered,
      });
    }

    function topBottom(rows: RankedEmail[]) {
      const sorted = [...rows].sort((a, b) => b.clickRate - a.clickRate);
      return {
        top5: sorted.slice(0, 5),
        bottom5: [...sorted].reverse().slice(0, 5),
        count: rows.length,
      };
    }

    // Matches the reference report: a segment with too few sends to make
    // a meaningful Top/Bottom cut (<=5) is shown as its full population
    // instead of an artificial ranking.
    const SMALL_SEGMENT_THRESHOLD = 5;
    const prospect = topBottom(bySegment.prospect);
    const customer =
      bySegment.customer.length <= SMALL_SEGMENT_THRESHOLD
        ? { all: [...bySegment.customer].sort((a, b) => b.clickRate - a.clickRate), count: bySegment.customer.length }
        : topBottom(bySegment.customer);
    const mixed = topBottom(bySegment.mixed);

    return NextResponse.json({
      status: "ok",
      windowDays: WINDOW_DAYS,
      scannedCount: scanned.length,
      totalEmailsFetched: rawEmails.length,
      totalSentClassified: allEmails.length,
      distinctStatesSeen,
      truncated,
      minDeliveredForRanking: MIN_DELIVERED_FOR_CLICK_RANKING,
      trend,
      avgCtor30d,
      unsubRate30d,
      segments: { prospect, customer, mixed },
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
