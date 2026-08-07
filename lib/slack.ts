import { getPool } from "@/lib/db";
import { fetchMarketingEmailsPaginated, classifyEmailState, fetchEmailStats } from "@/lib/hubspot";

// Slack alerting — posts to the webhook in SLACK_WEBHOOK_URL_MOPS_EMAIL
// (#mops_email) only when
// Ready Room's own detection (Flagged Anomalies, Send Conflict
// Detector) finds something that actually needs a look. This is
// deliberately NOT a duplicate of the existing Dust/Zapier per-send
// reporting in Slack — that already reports every send unconditionally.
// This is the analytical layer on top: signal, not volume.
//
// Runs as part of the existing twice-daily snapshot cron (not a
// separate cron schedule) — see app/api/cron/snapshot-metrics/route.ts.
//
// Dedup: each anomaly/conflict gets a stable key built from the
// underlying email ID(s), not the display text (which can shift
// slightly run to run as percentages recompute). A key is only ever
// alerted once — see slack_alerts_sent in lib/db.ts.

// Known, stable production URL for this app — used for internal
// server-to-server calls to its own API routes, avoiding the need to
// duplicate the anomaly/conflict detection logic in a second place.
const APP_BASE_URL = "https://vanta-email.vercel.app";

// This whole domain sits behind Vercel SSO — confirmed directly, a
// server-to-server call without this header gets back the login page
// HTML instead of JSON. VERCEL_AUTOMATION_BYPASS_SECRET is Vercel's own
// mechanism for exactly this case (auto-injected once "Protection
// Bypass for Automation" is configured in Deployment Protection
// settings) — sent as a request header, not a query param.
function internalFetchHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return secret ? { "x-vercel-protection-bypass": secret } : {};
}

async function postToSlack(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL_MOPS_EMAIL;
  if (!webhookUrl) return; // not configured yet — silently skip, don't fail the whole cron over this

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

// Confirmed real gap: once something was alerted once, it was
// permanently excluded from all future checks — no re-check, no
// "resolved" signal, no reminder if it got worse. A false-positive
// alert (now largely prevented by the MIN_AGE_HOURS fix in
// anomalies/route.ts) would sit unresolved in Slack forever with no
// correction. Fixed by adding a TTL: an item is only suppressed if it
// was alerted within the last REMINDER_DAYS days. A genuinely resolved
// issue naturally stops reappearing in the candidate pool on its own
// (self-correcting, no code needed for that case) — this specifically
// handles the OTHER case, a problem that's still ongoing well past the
// window, which now gets a fresh reminder instead of silence.
const REMINDER_DAYS = 7;

async function alreadyAlerted(db: any, itemType: string, itemKey: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM slack_alerts_sent WHERE item_type = $1 AND item_key = $2 AND first_alerted_at > NOW() - INTERVAL '${REMINDER_DAYS} days'`,
    [itemType, itemKey]
  );
  return result.rows.length > 0;
}

async function markAlerted(db: any, itemType: string, itemKey: string): Promise<void> {
  await db.query(
    `INSERT INTO slack_alerts_sent (item_type, item_key) VALUES ($1, $2)
     ON CONFLICT (item_type, item_key) DO UPDATE SET first_alerted_at = NOW()`,
    [itemType, itemKey]
  );
}

export async function checkAndPostSlackAlerts(): Promise<{ posted: string[]; skipped: string[] }> {
  const db = getPool();
  const posted: string[] = [];
  const skipped: string[] = [];

  if (!process.env.SLACK_WEBHOOK_URL_MOPS_EMAIL) {
    skipped.push("all (SLACK_WEBHOOK_URL_MOPS_EMAIL not configured)");
    return { posted, skipped };
  }

  // --- Anomalies ---
  try {
    const res = await fetch(`${APP_BASE_URL}/api/hubspot/anomalies`, { headers: internalFetchHeaders() });
    const data = await res.json();
    if (data.status === "ok") {
      const criticalOrHigh = (data.flags || []).filter(
        (f: any) => f.riskLabel === "Critical" || f.riskLabel === "High"
      );
      for (const f of criticalOrHigh) {
        const key = `${f.emailId}:${f.metric}`;
        if (await alreadyAlerted(db, "anomaly", key)) {
          skipped.push(`anomaly:${key} (already alerted)`);
          continue;
        }
        const emoji = f.riskLabel === "Critical" ? "🚨" : "⚠️";
        const text =
          `${emoji} *${f.riskLabel} anomaly flagged* — ${f.emailName}\n` +
          `${f.cause}\n` +
          `<${APP_BASE_URL}|View in Ready Room →>`;
        await postToSlack(text);
        await markAlerted(db, "anomaly", key);
        posted.push(`anomaly:${key}`);
      }
    } else {
      skipped.push("anomalies (fetch error: " + data.message + ")");
    }
  } catch (error) {
    skipped.push("anomalies (fetch error: " + (error as Error).message + ")");
  }

  // --- Send conflicts ---
  try {
    const res = await fetch(`${APP_BASE_URL}/api/hubspot/conflicts`, { headers: internalFetchHeaders() });
    const data = await res.json();
    if (data.status === "ok") {
      for (const c of data.conflicts || []) {
        // Order-independent key — same pair flagged either direction is the same conflict
        const ids = [c.emailA.id, c.emailB.id].sort();
        const key = `${ids[0]}:${ids[1]}`;
        if (await alreadyAlerted(db, "conflict", key)) {
          skipped.push(`conflict:${key} (already alerted)`);
          continue;
        }
        const overlapText =
          c.contactsAtRiskEstimate !== null
            ? `~${c.contactsAtRiskEstimate.toLocaleString()} contacts at risk`
            : "shared audience, size unknown";
        const whenText = c.daysApart === 0 ? "same day" : `${c.daysApart}d apart`;
        const text =
          `⚠️ *Send conflict* — "${c.emailA.name}" and "${c.emailB.name}"\n` +
          `${whenText}, ${overlapText}\n` +
          `<${APP_BASE_URL}|View in Ready Room →>`;
        await postToSlack(text);
        await markAlerted(db, "conflict", key);
        posted.push(`conflict:${key}`);
      }
    } else {
      skipped.push("conflicts (fetch error: " + data.message + ")");
    }
  } catch (error) {
    skipped.push("conflicts (fetch error: " + (error as Error).message + ")");
  }

  return { posted, skipped };
}

// --- Routine send reporting (stopgap, per Justin — Dust/Zapier out of
// credits, this channel lost its per-send reporting entirely) ---
//
// Deliberately simplified from Dust/Zapier's real cadence, which (per
// a real screenshot) is actually 4 stages: immediate "sent" notice,
// ~24h delivery-only update, ~3-day full engagement update, ~7-day
// final check. Matching that exactly would take real time to get
// right; this is a stopgap, not a full replacement. Two stages
// instead: an immediate "sent" notice, then ONE metrics follow-up once
// the send has matured (reusing the same 24h MIN_AGE_HOURS threshold
// already proven for Anomalies — enough time for delivery + real
// engagement to land, without waiting a full week to say anything).
//
// Deliberately UNFILTERED — this reports on every real "sent" email,
// no RC/OP or re-engagement exclusions. Those exclusions exist
// specifically for anomaly DETECTION (comparing sends against each
// other); routine reporting isn't a comparison, so there's nothing for
// an unusual send type to skew. Matches Dust's original behavior,
// which reported on every send unconditionally, including small
// internal/test sends per the reference screenshot.

const SEND_REPORT_MIN_AGE_HOURS = 24;
const SEND_REPORT_LOOKBACK = 30; // most recent N sends considered per run — bounded, not unlimited history

export async function checkAndPostSendReporting(): Promise<{ posted: string[]; skipped: string[] }> {
  const db = getPool();
  const posted: string[] = [];
  const skipped: string[] = [];

  if (!process.env.SLACK_WEBHOOK_URL_MOPS_EMAIL) {
    skipped.push("all (SLACK_WEBHOOK_URL_MOPS_EMAIL not configured)");
    return { posted, skipped };
  }

  let emails: Array<{ id: string; name: string; publishDate: string }>;
  try {
    const rawEmails = await fetchMarketingEmailsPaginated(3);
    emails = rawEmails
      .filter((e: any) => classifyEmailState(e.state) === "sent" && !!e.publishDate)
      .sort((a: any, b: any) => new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime())
      .slice(0, SEND_REPORT_LOOKBACK)
      .map((e: any) => ({ id: e.id, name: e.name, publishDate: e.publishDate }));
  } catch (error) {
    return { posted, skipped: [`fetch sends failed: ${(error as Error).message}`] };
  }

  const ageCutoffMs = Date.now() - SEND_REPORT_MIN_AGE_HOURS * 60 * 60 * 1000;

  for (const email of emails) {
    // Stage 1: immediate "sent" notice — no age requirement, post as soon as we see it.
    const noticeKey = email.id;
    if (!(await alreadyAlerted(db, "send_notice", noticeKey))) {
      const text = `📤 *Email sent* — ${email.name}`;
      await postToSlack(text);
      await markAlerted(db, "send_notice", noticeKey);
      posted.push(`send_notice:${email.id}`);
    } else {
      skipped.push(`send_notice:${email.id} (already posted)`);
    }

    // Stage 2: one metrics follow-up, once the send is old enough to have real numbers.
    const metricsKey = email.id;
    const isMatureEnough = new Date(email.publishDate).getTime() <= ageCutoffMs;
    if (!isMatureEnough) {
      skipped.push(`send_metrics:${email.id} (too young for metrics yet)`);
      continue;
    }
    if (await alreadyAlerted(db, "send_metrics", metricsKey)) {
      skipped.push(`send_metrics:${email.id} (already posted)`);
      continue;
    }
    try {
      const stats = await fetchEmailStats(email.id);
      const openRate = stats.delivered > 0 ? ((stats.opens / stats.delivered) * 100).toFixed(1) : "0.0";
      const clickRate = stats.delivered > 0 ? ((stats.clicks / stats.delivered) * 100).toFixed(1) : "0.0";
      const text =
        `📊 *Performance* — ${email.name}\n` +
        `Sent: ${stats.sent} · Delivered: ${stats.delivered}\n` +
        `Opened: ${stats.opens} (${openRate}%) · Clicked: ${stats.clicks} (${clickRate}%) · Unsubscribed: ${stats.unsubscribed}`;
      await postToSlack(text);
      await markAlerted(db, "send_metrics", metricsKey);
      posted.push(`send_metrics:${email.id}`);
    } catch (error) {
      skipped.push(`send_metrics:${email.id} (fetch error: ${(error as Error).message})`);
    }
  }

  return { posted, skipped };
}
