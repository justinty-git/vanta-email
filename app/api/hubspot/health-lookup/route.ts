import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/health-lookup?query=<search term>
// Search-only, no dropdown (per prior design decision — dropdowns break at
// scale). Merges contact and list matches into one typeahead-friendly list.

type LookupResult = {
  id: string;
  type: "contact" | "list";
  name: string;
  meta: string;
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
    const [contactsRes, listsRes] = await Promise.all([
      hubspotFetch("/crm/v3/objects/contacts/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          limit: 5,
          properties: ["email", "firstname", "lastname"],
        }),
      }),
      hubspotFetch(
        `/crm/v3/lists/search?query=${encodeURIComponent(query)}&count=5`
      ).catch(() => ({ lists: [] })), // list search endpoint varies by scope tier — fail soft
    ]);

    const contactResults: LookupResult[] = (contactsRes.results || []).map(
      (c: any) => ({
        id: c.id,
        type: "contact",
        name:
          [c.properties?.firstname, c.properties?.lastname]
            .filter(Boolean)
            .join(" ") || c.properties?.email || `Contact ${c.id}`,
        meta: c.properties?.email || "",
      })
    );

    const listResults: LookupResult[] = (listsRes.lists || []).map(
      (l: any) => ({
        id: String(l.listId),
        type: "list",
        name: l.name,
        meta: `${l.additionalProperties?.hs_list_size ?? "?"} contacts`,
      })
    );

    return NextResponse.json({
      status: "ok",
      results: [...contactResults, ...listResults],
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
