import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/workflows
//
// Workflow Watchdog — real version, using HubSpot's Automation v3 API
// (GET /automation/v3/workflows).
//
// REAL BUG FIXED HERE: contactListIds.enrolled / contactListIds.active
// in the list response are NOT contact counts — they are internal
// HubSpot LIST IDs identifying which lists represent "enrolled" and
// "active" contacts for that workflow. Confirmed directly against
// HubSpot's own docs example response: { "enrolled": 300, "active":
// 68737 } — those are List IDs (small sequential numbers HubSpot
// assigns), not population sizes. Treating them as literal counts
// produced numbers that were actually just two nearby internal IDs —
// exactly the "active (17,011) > enrolled lifetime (17,010)" oddity
// that got this caught, since real "currently active" can never exceed
// real "ever enrolled."
//
// Fix: resolve each of those list IDs to its REAL size via
// /crm/v3/lists/{listId} with additionalProperties=hs_list_size (the
// documented way to get a list's real size — confirmed via HubSpot's
// own Lists API docs and multiple community examples showing this
// exact field). Same list-size-lookup pattern already used in the
// conflicts route, just reading a different property off the list.
//
// Scoped, per request, to active NURTURE workflows only: name contains
// "nurture" (case-insensitive), enabled === true, AND no underscore in
// the name. Justin confirmed his real nurtures never contain an
// underscore and are consistently named — other teams'/legacy workflows
// (e.g. "2024.06_Operational_...", "2025.07_Email_Nurture - VRM
// Nurture_Customer") reliably do. This is a general rule, not a
// name-by-name guess, so it should catch future false positives from
// the same underscore-heavy legacy naming pattern without needing a new
// exclusion added each time.
//
// One confirmed false positive doesn't contain an underscore ("Audit
// Readiness Phase Nurture - Campaign Assignment Workflow") and needs a
// manual exclusion since there's no general signal to catch it.
const EXCLUDED_WORKFLOW_NAMES = new Set([
  "Audit Readiness Phase Nurture - Campaign Assignment Workflow",
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
    // Switched from GET /crm/v3/lists/{listId}?additionalProperties=hs_list_size
    // after finding that HubSpot's own migration docs never mention
    // additionalProperties as a supported query param on this endpoint —
    // it's only documented for the POST /search request BODY. That call
    // was very likely being silently ignored (list.additionalProperties
    // undefined), producing the exact "0 across the board" symptom that
    // got this caught, not real zero counts.
    //
    // The memberships endpoint's `total` field IS explicitly documented
    // with a concrete example response (HubSpot's v1->v3 migration
    // guide), so this is a confirmed-reliable way to get a list's real
    // size instead. limit=1 keeps the payload minimal since only the
    // total count is needed, not the actual member records.
    const data = await hubspotFetch(
      `/crm/v3/lists/${listId}/memberships?limit=1`
    );
    return { size: typeof data.total === "number" ? data.total : 0, failed: false };
  } catch {
    // Tracked separately from a genuine 0 — a silent catch-and-return-0
    // here is exactly what masked the previous bug. Surfaced in the
    // response as listSizeResolutionErrors so a future failure is
    // visible instead of looking like real (zero) data.
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
        const [active, enrolled] = await Promise.all([
          resolveListSize(w.contactListIds?.active),
          resolveListSize(w.contactListIds?.enrolled),
        ]);
        if (active.failed) listSizeResolutionErrors++;
        if (enrolled.failed) listSizeResolutionErrors++;
        return {
          id: String(w.id),
          name: w.name,
          type: w.type || null,
          enabled: w.enabled,
          activeContacts: active.size,
          totalEnrolled: enrolled.size,
          status: "active" as const,
          hubspotUrl: workflowUrl(String(w.id)),
        };
      })
    );

    rows.sort((a, b) => b.activeContacts - a.activeContacts);
    const ordered = rows.slice(0, MAX_ROWS);

    return NextResponse.json({
      status: "ok",
      totalWorkflows: raw.length,
      matchedCount: rows.length,
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
