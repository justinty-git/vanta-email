import { NextResponse } from "next/server";
import { computeSegmentHealth } from "@/lib/hubspot";

// GET /api/hubspot/segment-health
//
// Segment Health Tracking — "right now" view. Compares two HubSpot
// list sizes (base region segment vs. its "- Healthy" clone) rather
// than pulling individual contacts, so it scales to any region size —
// confirmed necessary after NAMER alone turned out to be 200K+ contacts.
//
// Shares computeSegmentHealth() with the daily snapshot cron job
// (see app/api/cron/snapshot-metrics), so the live view and the stored
// history can never silently drift apart — same logic, same config.

export async function GET() {
  try {
    const segments = await computeSegmentHealth();

    return NextResponse.json({
      status: "ok",
      segments,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
