import { NextResponse } from "next/server";
import { hubspotFetch } from "@/lib/hubspot";

// GET /api/hubspot/health-lookup?query=<search term>
// Purpose: search/typeahead lookup only (never a dropdown — breaks at scale
// per prior design decision). Returns basic health signals for a contact
// or list matching the query.
//
// TODO once scopes are confirmed live:
// 1. Search contacts (crm.objects.contacts.read) by name/email
// 2. Search lists (crm.lists.read) by name
// 3. Merge results into a single typeahead-friendly shape

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query");

  if (!query) {
    return NextResponse.json(
      { status: "error", message: "Missing required 'query' parameter." },
      { status: 400 }
    );
  }

  try {
    const data = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        limit: 10,
        properties: ["email", "firstname", "lastname"],
      }),
    });

    return NextResponse.json({
      status: "ok",
      note: "Placeholder response — replace with real health-lookup logic.",
      raw: data,
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: (error as Error).message },
      { status: 500 }
    );
  }
}
