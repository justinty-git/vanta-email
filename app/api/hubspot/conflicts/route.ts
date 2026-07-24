import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/conflicts
//
// Send Conflict Detector: cross-references scheduled marketing emails to flag
// genuine sends competing for the same inboxes — same or adjacent send date
// AND at least one shared target list.
//
// Data model notes (as of the marketing/v3/emails API, post ILS migration):
// - Each email's audience lives under `to.contactIlsLists.include` (current)
//   and, for older/unmigrated emails, `to.contactLists.include` (legacy —
//   HubSpot has been phasing this out; we still read it as a fallback so
//   older scheduled sends aren't silently skipped).
// - `publishDate` is the scheduled/actual send time (ISO string).
//
// Conflict definition:
// - Two SCHEDULED emails are flagged if abs(date difference) <= ADJACENT_DAYS
//   AND they share at least one target list ID.
// - "Contacts at risk" is an ESTIMATE: the smaller of the two lists' sizes,
//   since we don't have per-contact intersection without a much heavier
//   batch-membership call. This is intentionally a ceiling, not an exact
//   count — the UI should label it as such.

const ADJACENT_DAYS = 1; // same day or the very next day counts as a conflict window

type RawEmail = {
  id: string;
  name: string;
  publishDate?: string;
  state?: string;
  to?: {
    contactIlsLists?: { include?: string[]; exclude?: string[] };
    contactLists?: { include?: string[]; exclude?: string[] };
  };
};

type ListInfo = { id: string; name: string; size: number | null };

function audienceListIds(email: RawEmail): string[] {
  const ils = email.to?.contactIlsLists?.include ?? [];
  const legacy = email.to?.contactLists?.include ?? [];
  return Array.from(new Set([...ils, ...legacy].map(String)));
}

function daysApart(a: string, b: string): number {
  const diffMs = Math.abs(new Date(a).getTime() - new Date(b).getTime());
  return diffMs / (1000 * 60 * 60 * 24);
}

async function resolveListInfo(listIds: string[]): Promise<Map<string, ListInfo>> {
  const map = new Map<string, ListInfo>();
  // Fetch sequentially rather than Promise.all to stay well under HubSpot's
  // burst rate limit — this endpoint only runs a handful of lookups per call
  // since it's deduped across all scheduled emails, not once per email.
  for (const id of listIds) {
    try {
      const data = await hubspotFetch(`/crm/v3/lists/${id}`);
      const list = data.list ?? data;
      map.set(id, {
        id,
        name: list.name || `List ${id}`,
        size: typeof list.size === "number" ? list.size : null,
      });
    } catch {
      // List may be deleted/inaccessible — still show the conflict, just
      // without a friendly name or size.
      map.set(id, { id, name: `List ${id}`, size: null });
    }
  }
  return map;
}

export async function GET() {
  try {
    const data = await hubspotFetch(
      "/marketing/v3/emails?limit=100&state=SCHEDULED"
    );
    const emails: RawEmail[] = (data.results || []).filter(
      (e: RawEmail) => !!e.publishDate
    );

    // Collect every distinct list ID referenced so we resolve each one once.
    const allListIds = new Set<string>();
    for (const email of emails) {
      for (const id of audienceListIds(email)) allListIds.add(id);
    }
    const listInfo = await resolveListInfo(Array.from(allListIds));

    const conflicts: Array<{
      emailA: { id: string; name: string; publishDate: string };
      emailB: { id: string; name: string; publishDate: string };
      daysApart: number;
      sharedLists: ListInfo[];
      contactsAtRiskEstimate: number | null;
    }> = [];

    const unscoped: Array<{ id: string; name: string; publishDate: string }> = [];

    for (const email of emails) {
      if (audienceListIds(email).length === 0) {
        unscoped.push({
          id: email.id,
          name: email.name,
          publishDate: email.publishDate!,
        });
      }
    }

    for (let i = 0; i < emails.length; i++) {
      for (let j = i + 1; j < emails.length; j++) {
        const a = emails[i];
        const b = emails[j];
        const gap = daysApart(a.publishDate!, b.publishDate!);
        if (gap > ADJACENT_DAYS) continue;

        const listsA = audienceListIds(a);
        const listsB = audienceListIds(b);
        const shared = listsA.filter((id) => listsB.includes(id));
        if (shared.length === 0) continue;

        const sharedLists = shared.map(
          (id) => listInfo.get(id) || { id, name: `List ${id}`, size: null }
        );
        const sizes = sharedLists
          .map((l) => l.size)
          .filter((s): s is number => typeof s === "number");
        const contactsAtRiskEstimate = sizes.length ? Math.min(...sizes) : null;

        conflicts.push({
          emailA: { id: a.id, name: a.name, publishDate: a.publishDate! },
          emailB: { id: b.id, name: b.name, publishDate: b.publishDate! },
          daysApart: Math.round(gap * 10) / 10,
          sharedLists,
          contactsAtRiskEstimate,
        });
      }
    }

    // Highest estimated audience overlap first — that's what a MOps reviewer
    // would want to triage first.
    conflicts.sort(
      (x, y) => (y.contactsAtRiskEstimate ?? 0) - (x.contactsAtRiskEstimate ?? 0)
    );

    const conflictedIds = new Set<string>();
    for (const c of conflicts) {
      conflictedIds.add(c.emailA.id);
      conflictedIds.add(c.emailB.id);
    }
    const unscopedIds = new Set(unscoped.map((e) => e.id));

    // Full scanned list so the UI can render every scheduled send — not just
    // the conflicting pairs — with a status of conflict / clear / unscoped.
    const scanned = emails.map((e) => ({
      id: e.id,
      name: e.name,
      publishDate: e.publishDate!,
      status: conflictedIds.has(e.id)
        ? ("conflict" as const)
        : unscopedIds.has(e.id)
        ? ("unscoped" as const)
        : ("clear" as const),
    }));

    return NextResponse.json({
      status: "ok",
      scannedCount: emails.length,
      scanned,
      conflicts,
      unscoped, // scheduled emails with no resolvable list target — can't be checked for overlap
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
