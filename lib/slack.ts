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
// Still simplified from Dust/Zapier's real cadence (4 stages: immediate,
// ~24h delivery-only, ~3-day full engagement, ~7-day final check).
// This does 3: immediate "sent" notice, a 24h metrics update, and a
// 3-day metrics update — the 24h and 3-day stages are independent
// checks (not chained), since an email that's already had its 24h
// update posted still needs its own separate 3-day check in a later
// run. No 7-day final stage (yet) — can add the same pattern for a
// 4th stage if this stopgap needs to live longer than expected.
//
// Deliberately UNFILTERED (no RC/OP or re-engagement exclusions) —
// this is routine reporting, not send-to-send comparison, so there's
// nothing for an unusual send type to skew. Matches Dust's original
// behavior of reporting on every real send unconditionally.

const SEND_REPORT_MIN_AGE_HOURS = 24;
const SEND_REPORT_3DAY_HOURS = 72;
const SEND_REPORT_LOOKBACK = 60; // widened from 30 now that stage 3 needs a send to stay in this window for a full 3 days, not just 24h — bounded, not unlimited history

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

  const ageCutoff24h = Date.now() - SEND_REPORT_MIN_AGE_HOURS * 60 * 60 * 1000;
  const ageCutoff3day = Date.now() - SEND_REPORT_3DAY_HOURS * 60 * 60 * 1000;

  for (const email of emails) {
    const publishMs = new Date(email.publishDate).getTime();

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

    // Stages 2 and 3 are independent checks, NOT chained with an early
    // continue — an email that's already had its 24h update posted
    // still needs its own separate check for the 3-day update in a
    // later run. Each stage only cares about its own age threshold and
    // its own dedup key.
    const stages: Array<{ itemType: string; cutoffMs: number; label: string }> = [
      { itemType: "send_metrics", cutoffMs: ageCutoff24h, label: "24h" },
      { itemType: "send_metrics_3day", cutoffMs: ageCutoff3day, label: "3-day" },
    ];

    for (const stage of stages) {
      const isMatureEnough = publishMs <= stage.cutoffMs;
      if (!isMatureEnough) {
        skipped.push(`${stage.itemType}:${email.id} (too young for ${stage.label} update yet)`);
        continue;
      }
      if (await alreadyAlerted(db, stage.itemType, email.id)) {
        skipped.push(`${stage.itemType}:${email.id} (already posted)`);
        continue;
      }
      try {
        const stats = await fetchEmailStats(email.id);
        const openRate = stats.delivered > 0 ? ((stats.opens / stats.delivered) * 100).toFixed(1) : "0.0";
        const clickRate = stats.delivered > 0 ? ((stats.clicks / stats.delivered) * 100).toFixed(1) : "0.0";
        const headerLabel = stage.label === "24h" ? "Performance" : "Performance (3-day update)";
        const text =
          `📊 *${headerLabel}* — ${email.name}\n` +
          `Sent: ${stats.sent} · Delivered: ${stats.delivered}\n` +
          `Opened: ${stats.opens} (${openRate}%) · Clicked: ${stats.clicks} (${clickRate}%) · Unsubscribed: ${stats.unsubscribed}`;
        await postToSlack(text);
        await markAlerted(db, stage.itemType, email.id);
        posted.push(`${stage.itemType}:${email.id}`);
      } catch (error) {
        skipped.push(`${stage.itemType}:${email.id} (fetch error: ${(error as Error).message})`);
      }
    }
  }

  return { posted, skipped };
}
