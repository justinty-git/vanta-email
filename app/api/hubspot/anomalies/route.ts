import { NextResponse } from "next/server";
import { hubspotFetch, fetchMarketingEmailsPaginated, classifyEmailState } from "@/lib/hubspot";

// GET /api/hubspot/anomalies
//
// Flagged Anomalies — HubSpot-only version (no Snowflake dependency).
// Pulls the most recently SENT marketing emails (last 7 max), fetches
// real post-send stats for each, and flags any email whose
// deliverability/engagement numbers deviate meaningfully from the
// recent baseline (the MEDIAN across the same batch — not the mean,
// since a mean lets one high-performing outlier drag the baseline up
// and make every other normal send look like an underperformer by
// comparison) OR breach known hard deliverability thresholds.
//
// Bounce rate deliberately excluded as a flaggable metric (removed per
// Justin: not something actionable day-to-day, and was triggering on
// nearly every send). Open rate also deliberately excluded (removed
// per Justin: Apple Mail Privacy Protection's image prefetching, live
// since 2021, means open events fire regardless of whether a person
// actually opened the email — widely treated industry-wide as
// unreliable beyond a rough directional signal, not something worth
// flagging deviations on). Spam/unsub/click rate remain.
//
// This intentionally does NOT try to reproduce the Snowflake-backed CTOR
// trend / Top-5-Bottom-5 panels — those stay as-is. This is a parallel,
// HubSpot-only anomaly surface: per-send unsub/spam/click health, not
// historical trend analysis.
//
// Field names verified against HubSpot's Marketing Email statistics
// response: counters.{sent,delivered,open,click,bounce,unsubscribed,
// spamreport}, ratios.{openratio,clickratio,bounceratio,
// unsubscribedratio,spamreportratio}.

const RECENT_SEND_LIMIT = 7;

// Hard thresholds mirror HubSpot's own deliverability-suspension guidance
// (spam 0.1%, unsub 3%) as an absolute floor for "Critical", independent
// of how the rest of the recent batch is performing.
const HARD = {
  spamCritical: 0.001,
  unsubCritical: 0.03,
  unsubHigh: 0.02,
};

type EmailSummary = {
  id: string;
  name: string;
  publishDate: string;
};

type Metrics = {
  sent: number;
  delivered: number;
  openRate: number | null;
  clickRate: number | null;
  bounceRate: number | null;
  unsubRate: number | null;
  spamRate: number | null;
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
  const delivered = counters.delivered ?? counters.deliveries ?? sent;
  const open = counters.open ?? 0;
  const click = counters.click ?? 0;
  const bounce = counters.bounce ?? 0;
  const unsubscribed = counters.unsubscribed ?? 0;
  const spamreport = counters.spamreport ?? 0;

  return {
    sent,
    delivered,
    // Derived from raw counters, not HubSpot's ratios.* fields — see
    // email-stats/route.ts for why (inconsistent scale across accounts).
    openRate: delivered > 0 ? open / delivered : null,
    clickRate: delivered > 0 ? click / delivered : null,
    bounceRate: sent > 0 ? bounce / sent : null,
    unsubRate: delivered > 0 ? unsubscribed / delivered : null,
    spamRate: delivered > 0 ? spamreport / delivered : null,
  };
}

// Median, not mean — a single high-performing outlier in a small batch
// (12 sends) can drag a mean baseline up enough that every OTHER normal,
// tightly-clustered send looks like a severe underperformer by
// comparison, even though nothing is actually wrong with them. This was
// confirmed as the real cause of a false-alarm pileup (nearly every send
// flagged Critical/High with suspiciously similar-looking deviations —
// a tell that the baseline itself was skewed, not that 8+ sends were
// simultaneously broken). Median isn't pulled around by one outlier the
// same way.
function median(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

// Excludes sends whose name ends in an RC or OP suffix (e.g. "...RC1",
// "...OP3") — per Justin, these shouldn't be considered for anomaly
// flagging. Applied BEFORE slicing to RECENT_SEND_LIMIT so an excluded
// send doesn't crowd out a real candidate within the scan window.
const EXCLUDE_SUFFIX = /\b(RC|OP)\d*\s*$/i;

// Excludes re-engagement / win-back sends — these deliberately target a
// dormant/low-engagement audience, so naturally-low click rates aren't
// an anomaly, they're the expected outcome of who's being emailed. If
// left in, a re-engagement send could either get falsely flagged itself,
// or (worse) drag the MEDIAN baseline down enough to make genuinely
// normal sends to engaged audiences look artificially fine by
// comparison. "Anti-Ghost" is a real, currently-active nurture name in
// this account (confirmed via Workflow Watchdog), not a hypothetical
// case. Applied the same way as EXCLUDE_SUFFIX — before slicing, so
// excluded sends affect neither the candidate pool nor the baseline.
const EXCLUDE_REENGAGEMENT = /\b(re-?engagement|win-?back|anti-?ghost|reactivat(e|ion)|dormant)\b/i;

// Excludes sends younger than this from the candidate pool (and the
// baseline). Confirmed real gap via a live example: a send flagged as
// "Critical" for a 58% click-rate drop just a few hours after going
// out — but clicks accumulate over hours/days, so a young send's
// PARTIAL click rate will always look artificially low compared to a
// fully-matured baseline built from older, fully-accumulated sends.
// That's not a real anomaly, it's a timing artifact. Most email
// engagement lands within the first 24 hours, so that's the threshold
// used here — long enough for a real signal to emerge, short enough to
// still catch problems promptly.
const MIN_AGE_HOURS = 24;

export async function GET() {
  try {
    const rawEmails = await fetchMarketingEmailsPaginated(3);
    const distinctStatesSeen = Array.from(
      new Set(rawEmails.map((e: any) => e.state).filter(Boolean))
    );
    const minAgeMs = MIN_AGE_HOURS * 60 * 60 * 1000;
    const ageCutoff = Date.now() - minAgeMs;

    const emails: EmailSummary[] = rawEmails
      .filter((e: any) => classifyEmailState(e.state) === "sent" && !!e.publishDate)
      .filter((e: any) => !EXCLUDE_SUFFIX.test(e.name || ""))
      .filter((e: any) => !EXCLUDE_REENGAGEMENT.test(e.name || ""))
      .filter((e: any) => new Date(e.publishDate).getTime() <= ageCutoff)
      .sort(
        (a: any, b: any) =>
          new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime()
      )
      .slice(0, RECENT_SEND_LIMIT)
      .map((e: any) => ({ id: e.id, name: e.name, publishDate: e.publishDate }));

    // Sequential, not parallel — same rate-limit reasoning as the conflicts
    // route. RECENT_SEND_LIMIT keeps this bounded to a handful of calls.
    const metricsById = new Map<string, Metrics>();
    for (const e of emails) {
      try {
        metricsById.set(e.id, await fetchMetrics(e.id));
      } catch {
        // Skip emails whose stats fail to load rather than failing the
        // whole panel.
      }
    }

    const baseline = {
      clickRate: median(Array.from(metricsById.values()).map((m) => m.clickRate)),
      unsubRate: median(Array.from(metricsById.values()).map((m) => m.unsubRate)),
      spamRate: median(Array.from(metricsById.values()).map((m) => m.spamRate)),
    };

    type Flag = {
      emailId: string;
      emailName: string;
      publishDate: string;
      metric: string;
      change: string;
      changeColor: string;
      riskColor: string;
      riskLabel: "Critical" | "High" | "Medium";
      riskRank: number;
      cause: string;
    };

    const danger = "var(--badge-danger-text)";
    const warn = "var(--badge-warning-text)";
    const flags: Flag[] = [];

    for (const e of emails) {
      const m = metricsById.get(e.id);
      if (!m) continue;

      const candidates: Array<{
        metric: string;
        rate: number | null;
        base: number | null;
        higherIsBad: boolean;
        hardCritical?: number;
        hardHigh?: number;
        minFloor?: number; // absolute floor below which relative-only flags are suppressed
        format: (v: number) => string;
      }> = [
        {
          metric: "Spam complaints",
          rate: m.spamRate,
          base: baseline.spamRate,
          higherIsBad: true,
          hardCritical: HARD.spamCritical,
          minFloor: 0.0003,
          format: (v) => (v * 100).toFixed(3) + "%",
        },
        {
          metric: "Unsub rate",
          rate: m.unsubRate,
          base: baseline.unsubRate,
          higherIsBad: true,
          hardCritical: HARD.unsubCritical,
          hardHigh: HARD.unsubHigh,
          minFloor: 0.01,
          format: (v) => (v * 100).toFixed(2) + "%",
        },
        {
          metric: "Click rate",
          rate: m.clickRate,
          base: baseline.clickRate,
          higherIsBad: false,
          format: (v) => (v * 100).toFixed(1) + "%",
        },
      ];

      let worst: Flag | null = null;

      for (const c of candidates) {
        if (c.rate === null) continue;
        const relChange = c.base && c.base > 0 ? (c.rate - c.base) / c.base : 0;

        let riskLabel: Flag["riskLabel"] | null = null;
        const meetsFloor = !c.minFloor || c.rate >= c.minFloor;
        if (c.higherIsBad) {
          if (c.hardCritical && c.rate >= c.hardCritical) riskLabel = "Critical";
          else if (c.hardHigh && c.rate >= c.hardHigh) riskLabel = "High";
          else if (meetsFloor && relChange >= 1.0) riskLabel = "High"; // more than double the baseline
          else if (meetsFloor && relChange >= 0.5) riskLabel = "Medium";
        } else {
          if (relChange <= -0.4) riskLabel = "High";
          else if (relChange <= -0.25) riskLabel = "Medium";
        }

        if (!riskLabel) continue;

        const rank = { Critical: 4, High: 3, Medium: 2 }[riskLabel];
        const changeLabel =
          c.base && c.base > 0
            ? (relChange >= 0 ? "+" : "") + Math.round(relChange * 100) + "%"
            : c.format(c.rate);
        const cause =
          c.base && c.base > 0
            ? `${c.metric} at ${c.format(c.rate)} vs ${c.format(c.base)} recent median`
            : `${c.metric} at ${c.format(c.rate)} — no baseline yet from this batch`;

        const severityColor = riskLabel === "Medium" ? warn : danger;
        const candidate: Flag = {
          emailId: e.id,
          emailName: e.name,
          publishDate: e.publishDate,
          metric: c.metric,
          change: changeLabel,
          changeColor: severityColor,
          riskColor: severityColor,
          riskLabel,
          riskRank: rank,
          cause,
        };

        if (!worst || rank > worst.riskRank) worst = candidate;
      }

      if (worst) flags.push(worst);
    }

    flags.sort((a, b) => b.riskRank - a.riskRank);

    return NextResponse.json({
      status: "ok",
      scannedCount: emails.length,
      totalEmailsFetched: rawEmails.length,
      distinctStatesSeen,
      baseline,
      flags,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
