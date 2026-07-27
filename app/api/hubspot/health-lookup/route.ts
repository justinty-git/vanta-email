import { NextResponse } from "next/server";
import { fetchMarketingEmailsPaginated } from "@/lib/hubspot";

// GET /api/hubspot/health-lookup?query=<search term>
// Search sent/scheduled marketing emails by name (matches the original
// design: "Search sent emails by name, date, or ID…"). Search-only,
// no dropdown — dropdowns break at scale per prior design decision.
//
// Reach: HubSpot's Marketing Emails API doesn't support free-text
// search server-side, so this pulls a batch of the most recently
// UPDATED emails and filters by name here — NOT a clean "last N days"
// window. Uses the same fetchMarketingEmailsPaginated() helper already
// proven in the conflicts/anomalies/performance routes (up to 5 pages,
// 500 emails) instead of a single page of 100, for meaningfully deeper
// reach. Still not unlimited: an email that hasn't been touched in a
// long time could still fall outside this batch if 500+ other emails
// have been updated more recently. If that becomes a real problem,
// the fix is a name-indexed search rather than more pages.

type LookupResult = {
  id: string;
  name: string;
  meta: string; // e.g. "Sent Jul 16, 2026"
  state: string;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query")?.trim();

  if (!query) {
    return NextResponse.json(
      { status: "error", message: "Missing required 'query' parameter." },
      { status: 400 }
    );
  }

  try {
    const rawEmails = await fetchMarketingEmailsPaginated(5);

    const q = query.toLowerCase();
    const matches = rawEmails.filter((email: any) =>
      (email.name || "").toLowerCase().includes(q)
    );

    const results: LookupResult[] = matches.slice(0, 10).map((email: any) => ({
      id: email.id,
      name: email.name,
      meta: email.publishDate
        ? new Date(email.publishDate).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "No send date",
      state: email.state,
    }));

    return NextResponse.json({ status: "ok", results, totalScanned: rawEmails.length });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
