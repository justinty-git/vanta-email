import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/workflows
//
// Workflow Watchdog — real version, using HubSpot's Automation v3 API
// (GET /automation/v3/workflows).
//
// STATUS: contact counts restored, PROVISIONALLY, pending confirmation
// against real ground truth. History: first attempt treated
// contactListIds.enrolled/active as literal counts (wrong — active >
// enrolled lifetime is logically impossible). Second attempt resolved
// them as list IDs via GET /crm/v3/lists/{id}/memberships, producing
// ~11k for one workflow ("Signal 2"), which looked wrong at a glance.
// Justin then shared that workflow's REAL numbers from HubSpot's own UI:
// Currently Enrolled 10,528, Enrolled last 7-days 40, Enrolled unique
// 10,468, Enrolled total 10,770 — all close to the ~11k this route was
// already producing, suggesting the magnitude was in the right range
// and the earlier concern may have been about labeling, not the number
// itself being fabricated.
//
// Current mapping (best guess, not yet confirmed exact):
// contactListIds.active   -> labeled "Currently Enrolled"
// contactListIds.enrolled -> labeled "Enrolled Total"
// This matches HubSpot's own UI terminology as closely as possible
// given the two fields available. NEEDS CONFIRMATION: once deployed,
// check whether Signal 2 shows Currently Enrolled=10,528 and Enrolled
// Total=10,770 specifically — if the numbers are close but swapped or
// off, that tells us exactly what to correct next, rather than guessing
// again from documentation alone.
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

async function resolveListSize(
  listId: number | undefined
): Promise<{ size: number; failed: boolean }> {
  if (!listId) return { size: 0, failed: false };
  try {
    const data = await hubspotFetch(
      `/crm/v3/lists/${listId}/memberships?limit=1`
    );
    return { size: typeof data.total === "number" ? data.total : 0, failed: false };
  } catch {
    // Tracked separately from a genuine 0 — masking a real failure as 0
    // is exactly what caused past confusion on this route.
    return { size: 0, failed: true };
  }
}

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

    let listSizeResolutionErrors = 0;

    const rows = await Promise.all(
      nurtureActive.map(async (w) => {
        const [currentlyEnrolled, enrolledTotal] = await Promise.all([
          resolveListSize(w.contactListIds?.active),
          resolveListSize(w.contactListIds?.enrolled),
        ]);
        if (currentlyEnrolled.failed) listSizeResolutionErrors++;
        if (enrolledTotal.failed) listSizeResolutionErrors++;
        return {
          id: String(w.id),
          name: w.name,
          type: w.type || null,
          enabled: w.enabled,
          currentlyEnrolled: currentlyEnrolled.size,
          enrolledTotal: enrolledTotal.size,
          status: "active" as const,
          hubspotUrl: workflowUrl(String(w.id)),
        };
      })
    );

    rows.sort((a, b) => b.currentlyEnrolled - a.currentlyEnrolled);
    const ordered = rows.slice(0, MAX_ROWS);

    return NextResponse.json({
      status: "ok",
      totalWorkflows: raw.length,
      matchedCount: rows.length,
      countsVerified: false,
      listSizeResolutionErrors,
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
