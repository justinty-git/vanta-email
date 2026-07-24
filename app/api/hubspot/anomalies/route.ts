import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/anomalies
//
// Flagged Anomalies — HubSpot-only version (no Snowflake dependency).
// Pulls the most recently SENT marketing emails, fetches real post-send
// stats for each, and flags any email whose deliverability/engagement
// numbers deviate meaningfully from the recent baseline (the average
// across the same batch) OR breach known hard deliverability thresholds.
//
// This intentionally does NOT try to reproduce the Snowflake-backed CTOR
// trend / Top-5-Bottom-5 panels — those stay as-is. This is a parallel,
// HubSpot-only anomaly surface: per-send bounce/unsub/spam/open/click
// health, not historical trend analysis.
//
// Field names verified against HubSpot's Marketing Email statistics
// response: counters.{sent,delivered,open,click,bounce,unsubscribed,
// spamreport}, ratios.{openratio,clickratio,bounceratio,
// unsubscribedratio,spamreportratio}.

const RECENT_SEND_LIMIT = 12;

// Hard thresholds mirror HubSpot's own deliverability-suspension guidance
// (bounce 5%, spam 0.1%, unsub 3%) as an absolute floor for "Critical",
// independent of how the rest of the recent batch is performing.
const HARD = {
  bounceCritical: 0.05,
  bounceHigh: 0.02,
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

function average(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export async function GET() {
  try {
    const listData = await hubspotFetch(
      `/marketing/v3/emails?limit=${RECENT_SEND_LIMIT}&state=SENT&sort=-publishDate`
    );
    const emails: EmailSummary[] = (listData.results || [])
      .filter((e: any) => !!e.publishDate)
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
      openRate: average(Array.from(metricsById.values()).map((m) => m.openRate)),
      clickRate: average(Array.from(metricsById.values()).map((m) => m.clickRate)),
      bounceRate: average(Array.from(metricsById.values()).map((m) => m.bounceRate)),
      unsubRate: average(Array.from(metricsById.values()).map((m) => m.unsubRate)),
      spamRate: average(Array.from(metricsById.values()).map((m) => m.spamRate)),
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
        format: (v: number) => string;
      }> = [
        {
          metric: "Bounce rate",
          rate: m.bounceRate,
          base: baseline.bounceRate,
          higherIsBad: true,
          hardCritical: HARD.bounceCritical,
          hardHigh: HARD.bounceHigh,
          format: (v) => (v * 100).toFixed(2) + "%",
        },
        {
          metric: "Spam complaints",
          rate: m.spamRate,
          base: baseline.spamRate,
          higherIsBad: true,
          hardCritical: HARD.spamCritical,
          format: (v) => (v * 100).toFixed(3) + "%",
        },
        {
          metric: "Unsub rate",
          rate: m.unsubRate,
          base: baseline.unsubRate,
          higherIsBad: true,
          hardCritical: HARD.unsubCritical,
          hardHigh: HARD.unsubHigh,
          format: (v) => (v * 100).toFixed(2) + "%",
        },
        {
          metric: "Open rate",
          rate: m.openRate,
          base: baseline.openRate,
          higherIsBad: false,
          format: (v) => (v * 100).toFixed(1) + "%",
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
        if (c.higherIsBad) {
          if (c.hardCritical && c.rate >= c.hardCritical) riskLabel = "Critical";
          else if (c.hardHigh && c.rate >= c.hardHigh) riskLabel = "High";
          else if (relChange >= 1.0) riskLabel = "High"; // more than double the baseline
          else if (relChange >= 0.5) riskLabel = "Medium";
        } else {
          if (relChange <= -0.4) riskLabel = "High";
          else if (relChange <= -0.25) riskLabel = "Medium";
        }

        if (!riskLabel) continue;

        const rank = { Critical: 4, High: 3, Medium: 2 }[riskLabel];
        const changeLabel =
          c.base && c.base > 0
            ? (relChange >= 0 ? "+" : "") + Math.round(relChange * 100) + "% vs recent avg"
            : c.format(c.rate);
        const cause =
          c.base && c.base > 0
            ? `${c.metric} at ${c.format(c.rate)} vs ${c.format(c.base)} recent average`
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
