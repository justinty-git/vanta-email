import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/audience-status
//
// "Segment Sizing" (renamed from "Audience Status") — a list of all
// segment totals as of today. Justin defines the segments (label +
// HubSpot list ID) — this route resolves each to its real name and
// size. Same list-resolution pattern already proven reliable in the
// conflicts route (list name via GET /crm/v3/lists/{listId}) and
// confirmed for size via GET /crm/v3/lists/{listId}/memberships (the
// memberships.total field is explicitly documented). This is a plain
// contact list lookup, not the Workflows/Flows-platform issue that
// broke Workflow Watchdog's contactListIds — that was a different,
// automation-specific API problem, not a general problem with list
// resolution.
//
// group distinguishes REGIONS from AUDIENCE TYPES (Prospects/Customers)
// — Justin flagged that Prospects/Customers aren't regions and
// shouldn't be lumped into the same panel, so the UI splits into two
// separate panel pairs based on this tag.

const SEGMENTS: Array<{ label: string; group: "region" | "audience"; listId: number }> = [
  { label: "Global", group: "region", listId: 30565 },
  { label: "NAMER", group: "region", listId: 31109 },
  { label: "EMEA", group: "region", listId: 31133 },
  { label: "APAC", group: "region", listId: 31134 },
  { label: "Other", group: "region", listId: 31136 },
  { label: "Prospects", group: "audience", listId: 31139 },
  { label: "Customers", group: "audience", listId: 31140 },
];

async function resolveSegment(listId: number): Promise<{
  label: string;
  listId: number;
  name: string | null;
  size: number | null;
  error: string | null;
}> {
  try {
    const [listData, membershipsData] = await Promise.all([
      hubspotFetch(`/crm/v3/lists/${listId}`),
      hubspotFetch(`/crm/v3/lists/${listId}/memberships?limit=1`),
    ]);
    const list = listData.list ?? listData;
    return {
      label: "",
      listId,
      name: list.name || null,
      size: typeof membershipsData.total === "number" ? membershipsData.total : null,
      error: null,
    };
  } catch (error) {
    return {
      label: "",
      listId,
      name: null,
      size: null,
      error: (error as Error).message,
    };
  }
}

export async function GET() {
  try {
    const resolved = await Promise.all(
      SEGMENTS.map(async (s) => {
        const r = await resolveSegment(s.listId);
        return { ...r, label: s.label, group: s.group };
      })
    );

    return NextResponse.json({
      status: "ok",
      segments: resolved,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
