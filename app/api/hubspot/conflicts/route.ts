import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/conflicts
// Purpose: cross-reference scheduled marketing emails for audience overlap
// so Send Conflict Detector can flag campaigns competing for the same inboxes
// on the same day.
//
// TODO once scopes are confirmed live:
// 1. Pull scheduled/upcoming marketing emails (marketing-email scope)
//    e.g. GET /marketing/v3/emails?state=SCHEDULED
// 2. For each email, resolve its target list(s)/segment (crm.lists.read)
// 3. Compare date + audience across all scheduled emails
// 4. Return overlapping pairs with an overlap % and the contact count at risk

export async function GET() {
  try {
    // Placeholder call — replace endpoint/params once the real conflict
    // logic is defined. This confirms the token + connection work end to end.
    const data = await hubspotFetch(
      "/marketing/v3/emails?limit=10&state=SCHEDULED"
    );

    return NextResponse.json({
      status: "ok",
      note: "Placeholder response — replace with real conflict-detection logic.",
      raw: data,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
