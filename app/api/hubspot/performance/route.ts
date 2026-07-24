import { NextResponse } from "next/server";
import { hubspotFetch, fetchMarketingEmailsPaginated, classifyEmailState } from "@/lib/hubspot";

// GET /api/hubspot/performance
//
// HubSpot-only replacement for the Snowflake-labeled CTOR Trend + Top5/
// Bottom5 Performance Report panels.
//
// Segmented into Prospect / Customer / Mixed Audience, matching the
// reference report — but per feedback, only Prospect gets a real Top 5 /
// Bottom 5 split. Customer and Mixed sends are shown as a single ranked
// list (by click rate, best first) with no "Bottom 5" framing, since in
// the reference report those segments either had too few sends for a
// meaningful cut or weren't ranked against a segment benchmark at all.
//
// Segment is inferred from the email's REAL audience targeting (which
// HubSpot lists it's actually sent to), not the email's own name — see
// classifySegmentFromLists() below for why name-parsing was replaced.
//
// Definitions:
// - Click rate = clicks / delivered — the ranking key.
// - CTOR (click-to-open rate) = clicks / opens — shown per email for
//   context, not used to rank.
// - Weekly trend buckets (unchanged, not segmented) are calendar weeks
//   (Mon–Sun): weekCTOR = sum(clicks) / sum(opens) for all sends whose
//   publishDate falls in that week.
// - Avg CTOR (30d) and Unsub rate (30d) are the same aggregate approach
//   over the trailing 30 days, also not segmented.
//
// Scope/cost note: this pulls per-email stats for up to MAX_EMAILS_SCANNED
// recent sends (one API call each, sequential). If your send volume is
// high enough that 8 full weeks exceeds that cap, older weeks in the
// trend will be based on fewer sends than they should be.

const WINDOW_DAYS = 56; // 8 weeks
const MAX_EMAILS_SCANNED = 60;
const MIN_DELIVERED_FOR_CLICK_RANKING = 50; // avoid noisy ratios from tiny sends
const TRAILING_30D_DAYS = 30;

// Real historical benchmark bands, sourced directly from Justin's June
// 2026 "Email Performance by Segment" report — NOT fabricated, and not a
// fresh historical-data pull (previously flagged as a bigger separate
// task). That report already computed these from real percentile
// analysis: Prospect n=427 historical sends, Customer n=185 historical
// sends (both Feb 2025-July 2026). Mixed Audience intentionally has no
// band here, matching that report's own conclusion — the 15 historical
// mixed sends span too wide a range (13.9%-59.2% open) to support one
// meaningful band.
//
// NOTE: these are a snapshot from that one report, not a live rolling
// calculation — if Justin re-runs that percentile analysis later with a
// larger or more recent sample, these numbers should be updated to match.
const BENCHMARKS: Record<"prospect" | "customer", {
  openRate: { below: number; above: number };
  clickRate: { below: number; above: number };
  unsubRate: { good: number; bad: number }; // lower is better for unsub
}> = {
  prospect: {
    openRate: { below: 0.271, above: 0.369 },
    clickRate: { below: 0.006, above: 0.0147 },
    unsubRate: { good: 0.0074, bad: 0.0126 },
  },
  customer: {
    openRate: { below: 0.364, above: 0.474 },
    clickRate: { below: 0.0061, above: 0.0198 },
    unsubRate: { good: 0.0038, bad: 0.007 },
  },
};

function rateBenchmark(
  value: number,
  band: { below: number; above: number }
): "Below Benchmark" | "Within Benchmark" | "Above Benchmark" {
  if (value < band.below) return "Below Benchmark";
  if (value > band.above) return "Above Benchmark";
  return "Within Benchmark";
}

function unsubBenchmark(
  value: number,
  band: { good: number; bad: number }
): "Above Benchmark" | "Within Benchmark" | "Below Benchmark" {
  // Inverted framing: LOWER unsub is "Above Benchmark" (better than
  // typical), matching the reference report's own good/bad direction.
  if (value < band.good) return "Above Benchmark";
  if (value > band.bad) return "Below Benchmark";
  return "Within Benchmark";
}

type EmailSummary = {
  id: string;
  name: string;
  publishDate: string;
  to?: {
    contactIlsLists?: { include?: string[]; exclude?: string[] };
    contactLists?: { include?: string[]; exclude?: string[] };
  };
};
type Metrics = {
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  unsubscribed: number;
};
type Segment = "prospect" | "customer" | "mixed";
type ListInfo = { id: string; name: string };

function audienceListIds(email: EmailSummary): string[] {
  const ils = email.to?.contactIlsLists?.include ?? [];
  const legacy = email.to?.contactLists?.include ?? [];
  return Array.from(new Set([...ils, ...legacy].map(String)));
}

async function resolveListInfo(listIds: string[]): Promise<Map<string, ListInfo>> {
  const map = new Map<string, ListInfo>();
  for (const id of listIds) {
    try {
      const data = await hubspotFetch(`/crm/v3/lists/${id}`);
      const list = data.list ?? data;
      map.set(id, { id, name: list.name || `List ${id}` });
    } catch {
      map.set(id, { id, name: `List ${id}` });
    }
  }
  return map;
}

// Classifies by what the email ACTUALLY targets (real HubSpot list
// names), not by parsing the email's own name. This replaced an
// earlier name-based version after checking Justin's real June 2026
// report: the 4 genuinely mixed-audience sends in that report are named
// things like "Vanta Delivers Q2 | RC1" and "Trust Tour Paris | DG1" —
// none of them say "customer" or "prospect" in the name at all, so
// name-parsing could never have caught real Mixed sends, regardless of
// how the keyword logic was tuned.
//
// Caveat: this is only as good as how the underlying HubSpot LISTS are
// named. If a real cross-segment campaign targets a list with a generic
// name (e.g. "Vanta Delivers Q2 Master List") rather than something that
// says "Customers" or "Prospects", this will still miss it — same
// fundamental limitation, just moved from email names to list names,
// which are usually (not guaranteed) named more consistently. If Mixed
// is still empty after this, the reliable fix is Justin telling me the
// actual list IDs used for broad/cross-segment sends, the same way
// he's providing segment list IDs for Audience Status.
function classifySegmentFromLists(
  listIds: string[],
  listInfo: Map<string, ListInfo>
): Segment | "unclassified" {
  const names = listIds.map((id) => (listInfo.get(id)?.name || "").toLowerCase());
  const hasCustomer = names.some((n) => /\bcustomer(s)?\b/.test(n));
  const hasProspect = names.some((n) => /\bprospect(s)?\b/.test(n));
  if (hasCustomer && hasProspect) return "mixed";
  if (hasCustomer) return "customer";
  if (hasProspect) return "prospect";
  return "unclassified";
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
      .map((e: any) => ({ id: e.id, name: e.name, publishDate: e.publishDate, to: e.to }));

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

    // Resolve every distinct list targeted by any scanned email, once
    // each — same dedup pattern as the conflicts route, so this is a
    // handful of lookups total, not one per email.
    const allListIds = new Set<string>();
    for (const e of scanned) {
      for (const id of audienceListIds(e)) allListIds.add(id);
    }
    const listInfo = await resolveListInfo(Array.from(allListIds));

    // --- Weekly Click Rate trend ---
    // Switched from CTOR (clicks/opens) to Click Rate (clicks/delivered)
    // for consistency — Top5/Bottom5 elsewhere in this route already rank
    // by Click Rate to match the real reference report, so tracking a
    // different metric here was an inconsistency, not a deliberate choice.
    const weekTotals = new Map<string, { clicks: number; opens: number; delivered: number }>();
    for (const e of scanned) {
      const m = metricsByEmail.get(e.id);
      if (!m) continue;
      const key = weekKey(e.publishDate);
      const cur = weekTotals.get(key) || { clicks: 0, opens: 0, delivered: 0 };
      cur.clicks += m.clicks;
      cur.opens += m.opens;
      cur.delivered += m.delivered;
      weekTotals.set(key, cur);
    }
    const trend = Array.from(weekTotals.entries())
      .map(([week, t]) => ({
        week,
        clickRate: t.delivered > 0 ? t.clicks / t.delivered : null,
        ctor: t.opens > 0 ? t.clicks / t.opens : null,
        opens: t.opens,
        clicks: t.clicks,
        delivered: t.delivered,
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
    const avgClickRate30d = delivered30 > 0 ? clicks30 / delivered30 : null;
    const avgCtor30d = opens30 > 0 ? clicks30 / opens30 : null;
    const unsubRate30d = delivered30 > 0 ? unsub30 / delivered30 : null;

    // --- Segmented Top 5 / Bottom 5 (Prospect only) / ranked list (rest) ---
    type RankedEmail = {
      id: string;
      name: string;
      publishDate: string;
      clickRate: number;
      ctor: number | null;
      openRate: number | null;
      unsubRate: number | null;
      openRateBenchmark?: string;
      clickRateBenchmark?: string;
      unsubRateBenchmark?: string;
    };

    const bySegment: Record<Segment, RankedEmail[]> = { prospect: [], customer: [], mixed: [] };
    let unclassifiedCount = 0;
    for (const e of scanned) {
      const m = metricsByEmail.get(e.id);
      if (!m || m.delivered < MIN_DELIVERED_FOR_CLICK_RANKING) continue;
      const segment = classifySegmentFromLists(audienceListIds(e), listInfo);
      if (segment === "unclassified") {
        unclassifiedCount++;
        continue;
      }
      const clickRate = m.clicks / m.delivered;
      const openRate = m.delivered > 0 ? m.opens / m.delivered : null;
      const unsubRate = m.delivered > 0 ? m.unsubscribed / m.delivered : null;

      const row: RankedEmail = {
        id: e.id,
        name: e.name,
        publishDate: e.publishDate,
        clickRate,
        ctor: m.opens > 0 ? m.clicks / m.opens : null,
        openRate,
        unsubRate,
      };

      // Real benchmark ratings only apply to Prospect/Customer — Mixed has
      // no real band to compare against (see BENCHMARKS comment above).
      if (segment === "prospect" || segment === "customer") {
        const band = BENCHMARKS[segment];
        row.clickRateBenchmark = rateBenchmark(clickRate, band.clickRate);
        if (openRate !== null) row.openRateBenchmark = rateBenchmark(openRate, band.openRate);
        if (unsubRate !== null) row.unsubRateBenchmark = unsubBenchmark(unsubRate, band.unsubRate);
      }

      bySegment[segment].push(row);
    }

    const prospectSorted = [...bySegment.prospect].sort((a, b) => b.clickRate - a.clickRate);
    const prospect = {
      top5: prospectSorted.slice(0, 5),
      bottom5: [...prospectSorted].reverse().slice(0, 5),
      count: bySegment.prospect.length,
    };
    const customer = {
      ranked: [...bySegment.customer].sort((a, b) => b.clickRate - a.clickRate),
      count: bySegment.customer.length,
    };
    const mixed = {
      ranked: [...bySegment.mixed].sort((a, b) => b.clickRate - a.clickRate),
      count: bySegment.mixed.length,
    };

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
      avgClickRate30d,
      avgCtor30d,
      unsubRate30d,
      segments: { prospect, customer, mixed },
      unclassifiedCount,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
