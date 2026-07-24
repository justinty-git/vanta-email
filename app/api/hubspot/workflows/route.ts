import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/workflows
//
// Workflow Watchdog — real version, using HubSpot's Automation v3 API
// (GET /automation/v3/workflows). This is a legacy-but-still-documented
// endpoint that returns workflow metadata in one shot (no per-workflow
// call needed): { workflows: [{ id, name, type, enabled, contactListIds:
// { enrolled, active } }] }. Confirmed against HubSpot's own docs example
// response.
//
// `enabled` is the real active/paused signal. `contactListIds.active` is
// the count of contacts CURRENTLY sitting in the workflow (still
// in-progress); `contactListIds.enrolled` is the lifetime total ever
// enrolled. There is no real "frozen" concept in the API — that was a
// fabricated status in the old mock. The genuinely useful real signal
// this enables: a PAUSED workflow that still has active contacts sitting
// in it is a real risk (those contacts are stuck, not progressing) —
// that's what this route flags as "Stuck", replacing the fictional
// "Frozen" label.
//
// Scope note: the v3 workflows list endpoint doesn't document
// limit/offset/pagination params, so this fetches whatever HubSpot
// returns in one call. For accounts with very large workflow counts this
// could be a large (but metadata-only, not enrollment-level-detail)
// payload — if that becomes a problem, the fix is asking HubSpot support
// about the v4 flows endpoint's pagination instead.

const MAX_ROWS = 20;

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

    const rows = raw.map((w) => {
      const active = w.contactListIds?.active ?? 0;
      const enrolled = w.contactListIds?.enrolled ?? 0;
      const status: "stuck" | "active" | "paused" =
        !w.enabled && active > 0 ? "stuck" : w.enabled ? "active" : "paused";
      return {
        id: String(w.id),
        name: w.name,
        type: w.type || null,
        enabled: w.enabled,
        activeContacts: active,
        totalEnrolled: enrolled,
        status,
      };
    });

    // Stuck (paused-with-active-contacts) is the real risk signal, surfaced
    // first regardless of size. After that, active workflows by contact
    // volume — that's what a MOps reviewer would triage next. Idle paused
    // workflows (0 active contacts) are the least interesting and trimmed
    // first if the list needs to shrink to MAX_ROWS.
    const stuck = rows.filter((r) => r.status === "stuck").sort((a, b) => b.activeContacts - a.activeContacts);
    const active = rows.filter((r) => r.status === "active").sort((a, b) => b.activeContacts - a.activeContacts);
    const idle = rows.filter((r) => r.status === "paused").sort((a, b) => b.activeContacts - a.activeContacts);

    const ordered = [...stuck, ...active, ...idle].slice(0, MAX_ROWS);

    return NextResponse.json({
      status: "ok",
      totalWorkflows: raw.length,
      stuckCount: stuck.length,
      activeCount: active.length,
      pausedCount: idle.length,
      rows: ordered,
      truncated: raw.length > ordered.length,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
