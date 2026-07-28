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
// Currently one segment (NAMER). Add more entries to SEGMENTS below as
// the full region x persona list gets defined — no code changes
// needed, just new config rows.

const SEGMENTS: Array<{ label: string; listId: number }> = [
  { label: "Global Marketing Contacts", listId: 30565 },
  { label: "NAMER Marketing Contacts", listId: 31109 },
  { label: "EMEA Marketing Contacts", listId: 31133 },
  { label: "APAC Marketing Contacts", listId: 31134 },
  { label: "Other Marketing Contacts", listId: 31136 },
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
        return { ...r, label: s.label };
      })
    );

    return NextResponse.json({
      status: "ok",
      segments: resolved,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
