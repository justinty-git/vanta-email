import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/workflows
//
// Workflow Watchdog — real version, using HubSpot's Automation v3 API
// (GET /automation/v3/workflows).
//
// STATUS: contact counts are TEMPORARILY DISABLED. Two attempts at
// resolving contactListIds.enrolled/active into a real contact count
// have both produced numbers Justin confirmed are wrong (first
// treating them as literal counts — active > enrolled lifetime is
// logically impossible; then resolving them as list IDs via
// GET /crm/v3/lists/{id}/memberships — still produced implausible
// numbers, e.g. 11k+ "active" for a workflow that isn't that large).
// Both fixes were based on HubSpot's documentation, not on anything
// verified against this account's real data — and that documentation
// has already proven unreliable/ambiguous once (the additionalProperties
// query-param confusion). Rather than guess a third time, this route
// now surfaces the RAW contactListIds values honestly, unlabeled as a
// "count," so Justin can compare them against one workflow's real
// numbers in the HubSpot UI directly. Once we have that ground truth,
// the real fix (whatever it turns out to be) can be built with
// confidence instead of another guess.
//
// Scoped, per request, to active NURTURE workflows only: name contains
// "nurture" (case-insensitive), enabled === true, AND no underscore in
// the name. Justin confirmed his real nurtures never contain an
// underscore and are consistently named — other teams'/legacy workflows
// reliably do. This part is unaffected by the count issue above and
// has held up fine.
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
  contactListIds?: { enrolled?: number; active?: number };
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
        // Raw, unverified — see note above. Not labeled as a count on
        // purpose, to avoid repeating the same mistake a third time.
        rawActiveListId: w.contactListIds?.active ?? null,
        rawEnrolledListId: w.contactListIds?.enrolled ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const ordered = rows.slice(0, MAX_ROWS);

    return NextResponse.json({
      status: "ok",
      totalWorkflows: raw.length,
      matchedCount: rows.length,
      countsVerified: false,
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
