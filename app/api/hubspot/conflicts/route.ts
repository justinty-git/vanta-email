import { NextResponse } from "next/server";
import { hubspotFetch, fetchMarketingEmailsPaginated, classifyEmailState } from "@/lib/hubspot";

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
// - "Contacts at risk" is an ESTIMATE (the smaller of the two lists' sizes)
//   by default — but see REAL OVERLAP below.
//
// REAL OVERLAP (added per Justin — "the ultimate overlap detector"):
// The size-based estimate above only catches conflicts where both emails
// target the literal SAME list ID. It completely misses the more subtle,
// arguably more valuable case: two DIFFERENT lists (e.g. "NAMER
// Prospects" and "Enterprise Prospects") that still share real contacts.
// For every list pair across ALL scheduled emails in the window (not just
// already-same-ID matches), this checks the two lists' ACTUAL membership
// overlap — but only when BOTH lists are under SAFE_LIST_SIZE_CAP. Lists
// bigger than that (this account has several in the hundreds of
// thousands to millions — confirmed while building Region Tracking) are
// skipped with an honest "too large to check safely" flag rather than
// attempting a pull that would time out. This is a genuine scope
// limitation, not a bug: broad regional lists are already obviously
// risky if sent close together; the real NEW value here is catching
// subtler overlaps between smaller, more targeted lists.

const ADJACENT_DAYS = 1; // same day or the very next day counts as a conflict window
const WINDOW_DAYS = 14; // scan sends within the next 14 days
const SAFE_LIST_SIZE_CAP = 5000; // max list size to pull full membership for real overlap
const MAX_PAGES_PER_LIST = 50; // 50 x 100 = 5,000 — matches SAFE_LIST_SIZE_CAP

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

// Real overlap: pulls every member ID for a list, paginated, capped at
// MAX_PAGES_PER_LIST (SAFE_LIST_SIZE_CAP total). Returns null if the list
// is too large to check safely — caller must handle that as "can't
// compute real overlap for this pair", not silently return 0.
async function fetchMemberIdsCapped(listId: string): Promise<Set<string> | null> {
  const ids = new Set<string>();
  let after: string | undefined;

  for (let page = 0; page < MAX_PAGES_PER_LIST; page++) {
    const url =
      `/crm/v3/lists/${listId}/memberships?limit=100` +
      (after ? `&after=${encodeURIComponent(after)}` : "");
    const data = await hubspotFetch(url);
    for (const r of data.results || []) {
      if (r.recordId) ids.add(String(r.recordId));
    }
    after = data.paging?.next?.after;
    if (!after) return ids; // fully paginated within the cap — real, complete set
  }

  // Still has more pages after MAX_PAGES_PER_LIST — this list exceeds the
  // safe cap. Don't return a partial set pretending to be complete.
  return null;
}

// For a pair of emails, computes REAL contact-level overlap across every
// combination of their target lists (not just literally-shared IDs).
// Returns null (not 0) if any involved list exceeds the safe size cap —
// "couldn't check" must never look identical to "checked, found none".
async function computeRealOverlap(
  listsA: string[],
  listsB: string[],
  memberCache: Map<string, Set<string> | null>
): Promise<{ overlapCount: number; checkedListsA: string[]; checkedListsB: string[] } | null> {
  const distinctIds = Array.from(new Set([...listsA, ...listsB]));
  for (const id of distinctIds) {
    if (!memberCache.has(id)) {
      memberCache.set(id, await fetchMemberIdsCapped(id));
    }
  }

  // Any involved list too large (cached as null) means we can't safely
  // claim a real overlap number for this pair.
  if (distinctIds.some((id) => memberCache.get(id) === null)) return null;

  const unionA = new Set<string>();
  for (const id of listsA) {
    const members = memberCache.get(id);
    if (members) for (const m of members) unionA.add(m);
  }
  const unionB = new Set<string>();
  for (const id of listsB) {
    const members = memberCache.get(id);
    if (members) for (const m of members) unionB.add(m);
  }

  let overlapCount = 0;
  for (const id of unionA) if (unionB.has(id)) overlapCount++;

  return { overlapCount, checkedListsA: listsA, checkedListsB: listsB };
}

export async function GET() {
  try {
    const rawEmails = await fetchMarketingEmailsPaginated(5);
    const distinctStatesSeen = Array.from(
      new Set(rawEmails.map((e: any) => e.state).filter(Boolean))
    );

    const now = Date.now();
    const windowEnd = now + WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const emails: RawEmail[] = rawEmails.filter((e: RawEmail) => {
      if (classifyEmailState(e.state) !== "scheduled") return false;
      if (!e.publishDate) return false;
      const t = new Date(e.publishDate).getTime();
      return t >= now && t <= windowEnd;
    });

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
      realOverlapCount: number | null;
      realOverlapListsA: ListInfo[];
      realOverlapListsB: ListInfo[];
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

    // Shared across every pair checked in this request — a list looked up
    // once for one pair doesn't get re-pulled for another pair that also
    // references it.
    const memberCache = new Map<string, Set<string> | null>();

    for (let i = 0; i < emails.length; i++) {
      for (let j = i + 1; j < emails.length; j++) {
        const a = emails[i];
        const b = emails[j];
        const gap = daysApart(a.publishDate!, b.publishDate!);
        if (gap > ADJACENT_DAYS) continue;

        const listsA = audienceListIds(a);
        const listsB = audienceListIds(b);
        const shared = listsA.filter((id) => listsB.includes(id));

        if (shared.length > 0) {
          // Same list ID targeted by both — existing size-estimate path.
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
            realOverlapCount: null,
            realOverlapListsA: [],
            realOverlapListsB: [],
          });
          continue;
        }

        // No literal shared list ID — check for REAL overlap between the
        // DIFFERENT lists each email targets (the gap the size-estimate
        // approach above completely misses). Only flagged as a conflict
        // if genuine overlapping contacts are found AND every involved
        // list was small enough to check safely (null = skipped, not "0").
        if (listsA.length === 0 || listsB.length === 0) continue;
        const overlapResult = await computeRealOverlap(listsA, listsB, memberCache);
        if (overlapResult && overlapResult.overlapCount > 0) {
          conflicts.push({
            emailA: { id: a.id, name: a.name, publishDate: a.publishDate! },
            emailB: { id: b.id, name: b.name, publishDate: b.publishDate! },
            daysApart: Math.round(gap * 10) / 10,
            sharedLists: [],
            contactsAtRiskEstimate: overlapResult.overlapCount,
            realOverlapCount: overlapResult.overlapCount,
            realOverlapListsA: listsA.map((id) => listInfo.get(id) || { id, name: `List ${id}`, size: null }),
            realOverlapListsB: listsB.map((id) => listInfo.get(id) || { id, name: `List ${id}`, size: null }),
          });
        }
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
    // the conflicting pairs — with a status of conflict / clear / unscoped,
    // and its OWN target list names (not just the shared ones from a
    // conflict pair) so the Audience column can populate regardless of
    // whether that send is in a conflict.
    const scanned = emails.map((e) => {
      const listIds = audienceListIds(e);
      const lists = listIds.map(
        (id) => listInfo.get(id) || { id, name: `List ${id}`, size: null }
      );
      return {
        id: e.id,
        name: e.name,
        publishDate: e.publishDate!,
        lists,
        status: conflictedIds.has(e.id)
          ? ("conflict" as const)
          : unscopedIds.has(e.id)
          ? ("unscoped" as const)
          : ("clear" as const),
      };
    });

    return NextResponse.json({
      status: "ok",
      windowDays: WINDOW_DAYS,
      scannedCount: emails.length,
      totalEmailsFetched: rawEmails.length,
      distinctStatesSeen, // debugging aid — real state values as returned by HubSpot
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
