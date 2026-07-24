import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/email-stats?emailId=<id>
// Pulls real post-send statistics for a single marketing email —
// the same numbers shown on that email's Performance tab in HubSpot.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const emailId = searchParams.get("emailId");

  if (!emailId) {
    return NextResponse.json(
      { status: "error", message: "Missing required 'emailId' parameter." },
      { status: 400 }
    );
  }

  try {
    // HubSpot's statistics endpoint requires a startTimestamp — use a wide
    // window (5 years back to now) so we effectively get lifetime stats
    // for the email regardless of when it was sent.
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

    const sent = counters.sent ?? counters.processed ?? 0;
    // Fall back to sent count if HubSpot doesn't return a distinct
    // 'delivered' counter for this email (observed on some accounts/older
    // sends) — better to show a rate against sent than show nothing.
    const delivered = counters.delivered ?? counters.deliveries ?? sent;
    const opens = counters.open ?? counters.opens ?? 0;
    const clicks = counters.click ?? counters.clicks ?? 0;

    // Deliberately NOT using ratios.openratio/clickratio here — HubSpot's
    // ratios object has been observed returning inconsistent scale (a
    // fraction in some accounts, an already-multiplied percentage in
    // others), which was producing rates off by a factor of 100. Counters
    // are raw integers with no such ambiguity, so we always derive rate
    // locally: rate = count / delivered.
    const openRate = delivered > 0 ? opens / delivered : null;
    const clickRate = delivered > 0 ? clicks / delivered : null;

    return NextResponse.json({
      status: "ok",
      emailId,
      metrics: {
        sent,
        delivered,
        opens,
        clicks,
        openRate,
        clickRate,
      },
      raw: data,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
