import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/segment-health
//
// Segment Health Tracking — for a named HubSpot list, pulls every
// current member and evaluates each against a "healthy" (sendable)
// definition, computing total/healthy/rate. Unlike Underutilized
// Audience's global version (which had to replicate filter logic via
// property search due to scale — 400K+ contacts), a single regional
// segment is small enough to do this the direct way: pull every member
// ID, batch-read their properties, evaluate in code. Same real
// properties already verified for Underutilized Audience, plus two new
// ones (hs_email_quarantined, hs_email_bad_address) verified before use.
//
// PERSISTENCE NOTE: this route computes a live "right now" snapshot
// only. It does NOT yet store a time series — that needs Vercel KV
// (not set up yet) plus a Vercel Cron job to run this daily and append
// results. This is the compute logic; persistence is a distinct next
// step once KV exists.
//
// Config-driven per Justin's reusability note: SEGMENTS is a list of
// { label, listId } pairs. Adding a new region is adding a row here,
// not new code — the loop below handles any number of segments.

const SEGMENTS: Array<{ label: string; listId: number }> = [
  { label: "NAMER Contact Location", listId: 10077 },
];

const PAGE_LIMIT = 100;
const MAX_PAGES = 30; // safety cap — 30 x 100 = 3,000 members max per segment per run

type Contact = {
  id: string;
  properties: Record<string, string | null>;
};

async function fetchAllMemberIds(listId: number): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  let after: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `/crm/v3/lists/${listId}/memberships?limit=${PAGE_LIMIT}` +
      (after ? `&after=${encodeURIComponent(after)}` : "");
    const data = await hubspotFetch(url);
    const results = data.results || [];
    for (const r of results) {
      if (r.recordId) ids.push(String(r.recordId));
    }
    after = data.paging?.next?.after;
    if (!after) break;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return { ids, truncated };
}

async function batchReadContacts(ids: string[]): Promise<Contact[]> {
  const properties = [
    "hs_marketable_status",
    "hs_email_hard_bounce_reason_enum",
    "hs_email_optout",
    "hs_email_quarantined",
    "hs_email_bad_address",
  ];
  const contacts: Contact[] = [];

  // Batch read caps at 100 inputs per call.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const data = await hubspotFetch("/crm/v3/objects/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({
        inputs: chunk.map((id) => ({ id })),
        properties,
      }),
    });
    for (const r of data.results || []) {
      contacts.push({ id: r.id, properties: r.properties || {} });
    }
  }

  return contacts;
}

function isHealthy(c: Contact): boolean {
  const p = c.properties;
  return (
    p.hs_marketable_status === "true" &&
    !p.hs_email_hard_bounce_reason_enum &&
    p.hs_email_optout !== "true" &&
    p.hs_email_quarantined !== "true" &&
    p.hs_email_bad_address !== "true"
  );
}

async function computeSegmentHealth(segment: { label: string; listId: number }) {
  try {
    const { ids, truncated } = await fetchAllMemberIds(segment.listId);
    const contacts = await batchReadContacts(ids);
    const healthyCount = contacts.filter(isHealthy).length;
    const totalCount = contacts.length;
    return {
      label: segment.label,
      listId: segment.listId,
      totalCount,
      healthyCount,
      healthRate: totalCount > 0 ? healthyCount / totalCount : null,
      truncated,
      error: null as string | null,
    };
  } catch (error) {
    return {
      label: segment.label,
      listId: segment.listId,
      totalCount: 0,
      healthyCount: 0,
      healthRate: null,
      truncated: false,
      error: (error as Error).message,
    };
  }
}

export async function GET() {
  try {
    const segments = await Promise.all(SEGMENTS.map(computeSegmentHealth));

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
