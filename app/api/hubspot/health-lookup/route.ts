import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/health-lookup?query=<search term>
// Search sent/scheduled marketing emails by name (matches the original
// design: "Search sent emails by name, date, or ID…"). Search-only,
// no dropdown — dropdowns break at scale per prior design decision.

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
    // Marketing Emails API doesn't support free-text search server-side,
    // so pull a reasonably-sized recent batch and filter by name here.
    // Fine for now; revisit with pagination if the account's email volume
    // makes this batch too small to reliably match older sends.
    const data = await hubspotFetch(
      "/marketing/v3/emails?limit=100&sort=-updatedAt"
    );

    const q = query.toLowerCase();
    const matches = (data.results || []).filter((email: any) =>
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

    return NextResponse.json({ status: "ok", results });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
