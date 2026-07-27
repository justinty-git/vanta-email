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

type RawWorkflow = {
  id: number;
  name: string;
  type?: string;
  enabled: boolean;
  contactListIds?: { enrolled?: number; active?: number };
};

async function resolveListSize(listId: number | undefined): Promise<number> {
  if (!listId) return 0;
  try {
    const data = await hubspotFetch(
      `/crm/v3/lists/${listId}?additionalProperties=hs_list_size`
    );
    const list = data.list ?? data;
    const size = list.additionalProperties?.hs_list_size;
    return size !== undefined ? parseInt(size, 10) || 0 : 0;
  } catch {
    return 0;
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

    const rows = await Promise.all(
      nurtureActive.map(async (w) => {
        const [active, enrolled] = await Promise.all([
          resolveListSize(w.contactListIds?.active),
          resolveListSize(w.contactListIds?.enrolled),
        ]);
        return {
          id: String(w.id),
          name: w.name,
          type: w.type || null,
          enabled: w.enabled,
          activeContacts: active,
          totalEnrolled: enrolled,
          status: "active" as const,
        };
      })
    );

    rows.sort((a, b) => b.activeContacts - a.activeContacts);
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
