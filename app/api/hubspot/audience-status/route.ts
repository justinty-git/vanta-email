import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/audience-status
//
// Segment totals by region/persona. Justin defines the segments (label
// + HubSpot list ID) — this route resolves each to its real name and
// size. Same list-resolution pattern already proven reliable in the
// conflicts route (list name via GET /crm/v3/lists/{listId}) and
// confirmed for size via GET /crm/v3/lists/{listId}/memberships (the
// memberships.total field is explicitly documented). This is a plain
// contact list lookup, not the Workflows/Flows-platform issue that
// broke Workflow Watchdog's contactListIds — that was a different,
// automation-specific API problem, not a general problem with list
// resolution.
//
// Testing with ONE real segment first before scaling to the full
// 10-12 region x persona list. Add more entries to SEGMENTS below once
// this one is confirmed working end-to-end.

const SEGMENTS: Array<{ label: string; listId: number }> = [
  { label: "[NAMER] Contact Location | Marketable", listId: 31109 },
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
