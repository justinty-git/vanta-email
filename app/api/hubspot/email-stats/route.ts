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
    const data = await hubspotFetch(
      `/marketing/v3/emails/statistics/list?emailIds=${encodeURIComponent(
        emailId
      )}`
    );

    const counters = data.aggregate?.counters || {};
    const ratios = data.aggregate?.ratios || {};

    const sent = counters.sent ?? counters.processed ?? 0;
    const delivered = counters.delivered ?? 0;
    const opens = counters.open ?? counters.opens ?? 0;
    const clicks = counters.click ?? counters.clicks ?? 0;

    const openRate =
      ratios.open ?? (delivered > 0 ? opens / delivered : null);
    const clickRate =
      ratios.click ?? (delivered > 0 ? clicks / delivered : null);

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
