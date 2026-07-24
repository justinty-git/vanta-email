import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/workflows
//
// Workflow Watchdog — real version, using HubSpot's Automation v3 API
// (GET /automation/v3/workflows). Confirmed against HubSpot's own docs
// example response: { workflows: [{ id, name, type, enabled,
// contactListIds: { enrolled, active } }] } — no per-workflow call
// needed.
//
// Scoped, per request, to active NURTURE workflows only: name contains
// "nurture" (case-insensitive) AND enabled === true. This is a name/
// enabled filter, both already present in the list response at zero
// extra API cost — no per-workflow detail calls needed, unlike a
// creator filter would require (that was investigated and dropped:
// creator isn't in the list endpoint, only on the single-workflow
// detail endpoint, which would mean one call per workflow across
// potentially hundreds of workflows).
//
// `contactListIds.active` is the count of contacts CURRENTLY sitting in
// the workflow (still in-progress) — used to sort so the
// highest-volume active nurtures surface first.

const MAX_ROWS = 30;

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
      (w) => w.enabled && w.name.toLowerCase().includes("nurture")
    );

    const rows = nurtureActive
      .map((w) => {
        const active = w.contactListIds?.active ?? 0;
        const enrolled = w.contactListIds?.enrolled ?? 0;
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
      .sort((a, b) => b.activeContacts - a.activeContacts);

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
