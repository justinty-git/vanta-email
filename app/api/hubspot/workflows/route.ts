import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/workflows
//
// Workflow Watchdog — real version, using HubSpot's Automation v3 API
// (GET /automation/v3/workflows).
//
// STATUS: gave up guessing which label ("Currently Enrolled" vs
// "Enrolled Total") belongs to which of the two contactListIds fields —
// HubSpot's own workflow UI tracks FOUR numbers (Currently Enrolled,
// Enrolled last 7-days, Enrolled unique, Enrolled total), but the API
// only exposes TWO raw list IDs. There's no way to correctly guess a
// 2-to-4 mapping, so continuing to slap a label on it and call it
// "provisional" wasn't actually useful.
//
// Instead: fetch each list's REAL NAME (not just its size) via
// GET /crm/v3/lists/{listId}, alongside its size via
// GET /crm/v3/lists/{listId}/memberships. The list's own name is
// usually self-descriptive (HubSpot auto-names workflow-linked lists
// something like "Workflow: X - Active" or similar) and lets this
// self-document instead of guessing a label — no per-workflow manual
// confirmation needed to understand what a number represents.
//
// Both the size (memberships.total) and the name are 100% real, live
// HubSpot data — nothing here is mock or placeholder. The two numbers
// per workflow were never fake; only the LABEL guessing was the
// problem, which this removes entirely.
//
// Scoped, per request, to active NURTURE workflows only: name contains
// "nurture" (case-insensitive), enabled === true, AND no underscore in
// the name. Justin confirmed his real nurtures never contain an
// underscore and are consistently named — other teams'/legacy workflows
// reliably do.
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

async function resolveList(
  listId: number | undefined
): Promise<{ size: number; name: string | null; failed: boolean }> {
  if (!listId) return { size: 0, name: null, failed: false };
  try {
    const [membershipsData, listData] = await Promise.all([
      hubspotFetch(`/crm/v3/lists/${listId}/memberships?limit=1`),
      hubspotFetch(`/crm/v3/lists/${listId}`),
    ]);
    const size = typeof membershipsData.total === "number" ? membershipsData.total : 0;
    const list = listData.list ?? listData;
    const name = list.name || null;
    return { size, name, failed: false };
  } catch {
    // Tracked separately from a genuine 0 — masking a real failure as 0
    // is exactly what caused past confusion on this route.
    return { size: 0, name: null, failed: true };
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

    let resolutionErrors = 0;

    const rows = await Promise.all(
      nurtureActive.map(async (w) => {
        const [activeList, enrolledList] = await Promise.all([
          resolveList(w.contactListIds?.active),
          resolveList(w.contactListIds?.enrolled),
        ]);
        if (activeList.failed) resolutionErrors++;
        if (enrolledList.failed) resolutionErrors++;
        return {
          id: String(w.id),
          name: w.name,
          type: w.type || null,
          enabled: w.enabled,
          activeList: { size: activeList.size, name: activeList.name },
          enrolledList: { size: enrolledList.size, name: enrolledList.name },
          status: "active" as const,
          hubspotUrl: workflowUrl(String(w.id)),
        };
      })
    );

    rows.sort((a, b) => b.activeList.size - a.activeList.size);
    const ordered = rows.slice(0, MAX_ROWS);

    return NextResponse.json({
      status: "ok",
      totalWorkflows: raw.length,
      matchedCount: rows.length,
      resolutionErrors,
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
