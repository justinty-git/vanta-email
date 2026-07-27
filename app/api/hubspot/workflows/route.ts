import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/workflows
//
// Workflow Watchdog — real version, using HubSpot's Automation v3 API
// (GET /automation/v3/workflows).
//
// CONTACT COUNTS REMOVED — after four attempts, none produced numbers
// that matched reality:
// 1. Treated contactListIds.enrolled/active as literal counts (wrong —
//    active > enrolled lifetime is logically impossible)
// 2. Resolved them as list IDs via memberships.total (still didn't
//    match Justin's real HubSpot numbers)
// 3. Relabeled to HubSpot's UI terms, still didn't match
// 4. Showed the underlying list's real NAME instead of a guessed label
//    — still didn't match at all
//
// Likely root cause: Signal 2 (and probably other real nurtures here)
// are built on HubSpot's newer "Flows" platform (URL pattern
// /platform/flow/{id}/edit). HubSpot's own community forum has explicit
// reports that Flows-platform workflows don't reliably map to this
// legacy automation/v3/workflows API's data the same way older
// workflows do — which would explain why literally nothing lined up,
// not just a label. This needs real research into whether HubSpot has
// a Flows-specific API before attempting a fifth guess.
//
// What's left is only what's actually reliable: name, enabled status,
// and a real link to the workflow's HubSpot edit page. No contact
// counts until this is properly investigated.
//
// Scoped, per request, to active NURTURE workflows only: name contains
// "nurture" (case-insensitive), enabled === true, AND no underscore in
// the name. Justin confirmed his real nurtures never contain an
// underscore and are consistently named — other teams'/legacy workflows
// reliably do. This part is unaffected by the count issue above.
//
// Confirmed false positives without an underscore, needing manual
// exclusion since there's no general signal to catch them:
const EXCLUDED_WORKFLOW_NAMES = new Set([
  "Audit Readiness Phase Nurture - Campaign Assignment Workflow",
  "FY27 Lead scoring - Sponsored Event - Marketing Nurture",
]);

const MAX_ROWS = 30;

// Confirmed real pattern from an actual workflow in this portal:
// https://app.hubspot.com/workflows/8588479/platform/flow/1851248399/edit
const HUBSPOT_PORTAL_ID = "8588479";
const workflowUrl = (workflowId: string) =>
  `https://app.hubspot.com/workflows/${HUBSPOT_PORTAL_ID}/platform/flow/${workflowId}/edit`;

type RawWorkflow = {
  id: number;
  name: string;
  type?: string;
  enabled: boolean;
};

export async function GET() {
  try {
    const data = await hubspotFetch("/automation/v3/workflows");
    const raw: RawWorkflow[] = data.workflows || [];

    const nurtureActive = raw.filter(
      (w) =>
        w.enabled &&
        w.name.toLowerCase().includes("nurture") &&
        !w.name.includes("_") &&
        !EXCLUDED_WORKFLOW_NAMES.has(w.name)
    );

    const rows = nurtureActive
      .map((w) => ({
        id: String(w.id),
        name: w.name,
        type: w.type || null,
        enabled: w.enabled,
        status: "active" as const,
        hubspotUrl: workflowUrl(String(w.id)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const ordered = rows.slice(0, MAX_ROWS);

    return NextResponse.json({
      status: "ok",
      totalWorkflows: raw.length,
      matchedCount: rows.length,
      rows: ordered,
      truncated: rows.length > ordered.length,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
