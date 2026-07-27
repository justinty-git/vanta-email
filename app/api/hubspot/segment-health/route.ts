import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/segment-health
//
// Segment Health Tracking — REBUILT after confirming the original
// per-contact approach (pull every member, batch-read properties,
// evaluate healthy in code) doesn't scale. NAMER Contact Location alone
// is 200K+ contacts, with ~9 more regions planned — that's hundreds of
// paginated membership calls plus hundreds of batch-read calls PER
// region, well beyond what a serverless function can do in one
// execution, and would only get worse as more regions are added.
//
// New approach, per Justin's original clone-based plan: build the
// "healthy" definition INSIDE HubSpot as a real cloned list (base
// segment's filters + the 4 healthy-check groups on top), then this
// route just compares two list SIZES — the same cheap, confirmed
// memberships.total lookup already used everywhere else in this app
// (Send Conflict Detector, Audience Status, Underutilized Audience).
// Scales to any region size or number of regions, since it never
// touches individual contact records.
//
// Config-driven: SEGMENTS is a list of { label, baseListId,
// healthyListId } triples. Adding a new region is a config row.
//
// STATUS: only NAMER's base list ID (10077) is confirmed so far. The
// "- Healthy" clone list needs to be built in HubSpot first (per
// Justin's Step 1: base segment's filters + Marketing contact status +
// hard bounce reason unknown + not unsubscribed + not quarantined +
// not invalid, ANDed together) — healthyListId below is a placeholder
// until that exists and its real list ID is provided.

const SEGMENTS: Array<{ label: string; baseListId: number; healthyListId: number | null }> = [
  { label: "NAMER Contact Location", baseListId: 10077, healthyListId: null },
];

async function resolveListSize(listId: number | null): Promise<{ size: number | null; error: string | null }> {
  if (listId === null) return { size: null, error: "List not created yet" };
  try {
    const data = await hubspotFetch(`/crm/v3/lists/${listId}/memberships?limit=1`);
    return { size: typeof data.total === "number" ? data.total : null, error: null };
  } catch (error) {
    return { size: null, error: (error as Error).message };
  }
}

export async function GET() {
  try {
    const segments = await Promise.all(
      SEGMENTS.map(async (s) => {
        const [base, healthy] = await Promise.all([
          resolveListSize(s.baseListId),
          resolveListSize(s.healthyListId),
        ]);
        const healthRate =
          base.size !== null && base.size > 0 && healthy.size !== null
            ? healthy.size / base.size
            : null;
        return {
          label: s.label,
          baseListId: s.baseListId,
          healthyListId: s.healthyListId,
          totalCount: base.size,
          healthyCount: healthy.size,
          healthRate,
          error: base.error || healthy.error,
        };
      })
    );

    return NextResponse.json({
      status: "ok",
      segments,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
