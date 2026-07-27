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
// "nurture" (case-insensitive) AND enabled === true.
//
// Name-matching "nurture" catches some false positives that aren't
// actually Justin's email nurtures — e.g. operational/ops workflows
// that happen to have "Nurture" in their name but don't send email at
// all, or aren't his. Manual exclusion list below for confirmed cases.
const EXCLUDED_WORKFLOW_NAMES = new Set([
  "Campaign 2024.06_Operational_Customer Renewal_Nurture_Bounced",
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
