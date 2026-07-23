import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/workflows
// Purpose: power Workflow Watchdog — surface frozen/paused workflows and
// contacts stuck in paused workflows, building on the manual audit
// (1,089 workflows) already done by hand.
//
// TODO once scopes are confirmed live:
// 1. GET /automation/v4/flows (or equivalent) to list all workflows
// 2. Filter for isEnabled=false / paused status
// 3. Cross-reference against last-modified date to flag "frozen" candidates
// 4. Optionally pull enrolled-contact counts for paused workflows

export async function GET() {
  try {
    const data = await hubspotFetch("/automation/v4/flows?limit=10");

    return NextResponse.json({
      status: "ok",
      note: "Placeholder response — replace with real workflow-health logic.",
      raw: data,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
