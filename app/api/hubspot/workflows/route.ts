import { NextResponse } from "next/server";

// GET /api/hubspot/workflows
//
// Workflow Watchdog — manually maintained, not API-derived.
//
// After four failed attempts to pull real contact counts from
// HubSpot's automation/v3/workflows API, and confirmation from
// HubSpot's own community forum that the "flowId" needed for the
// modern Flows-platform URL isn't exposed via that API at all, this
// gave up on API automation entirely for this panel. Justin maintains
// this list by hand — he tells me when a nurture is added, removed, or
// its URL changes, and I update the array below. No HubSpot API calls,
// no guessing, no stale/wrong data — just what Justin has directly
// confirmed is real and current.
//
// To update: add/remove/edit entries in NURTURE_WORKFLOWS below.

const NURTURE_WORKFLOWS: Array<{ name: string; url: string; group: "Prospects" | "Customers" }> = [
  { name: "[GLOBAL] FY27 | Prospects | Nurture | Funnel | Signal 1", url: "https://app.hubspot.com/workflows/8588479/platform/flow/1835368082/edit", group: "Prospects" },
  { name: "[GLOBAL] FY27 | Prospects | Nurture | Funnel | Signal 2", url: "https://app.hubspot.com/workflows/8588479/platform/flow/1851248399/edit", group: "Prospects" },
  { name: "[NAMER] FY27 | Prospects | Nurture | Funnel | Signal 3", url: "https://app.hubspot.com/workflows/8588479/platform/flow/1851342624/edit", group: "Prospects" },
  { name: "[GLOBAL] FY27 | Prospects | Nurture | Funnel | Signal 4", url: "https://app.hubspot.com/workflows/8588479/platform/flow/1851343468/edit", group: "Prospects" },
  { name: "[GLOBAL] FY27 | Customers | CS | Nurture | V2 | Onboarding | Path 2 | Compliance Roadmap", url: "https://app.hubspot.com/workflows/8588479/platform/flow/1862801577/edit", group: "Customers" },
  { name: "[GLOBAL] FY27 | Customers | CS | Nurture | V2 | Onboarding | Re-engagement Workshop", url: "https://app.hubspot.com/workflows/8588479/platform/flow/1845633162/edit", group: "Customers" },
  { name: "[GLOBAL] FY27 | Customers | CS | Nurture | V2 | Onboarding | SOC 2 Guide", url: "https://app.hubspot.com/workflows/8588479/platform/flow/1861414455/edit", group: "Customers" },
  { name: "[GLOBAL] FY27 | Customers | CS | Nurture | V2 | Audit Readiness", url: "https://app.hubspot.com/workflows/8588479/platform/flow/1862801679/edit", group: "Customers" },
  { name: "[GLOBAL] FY27 | Customers | CS | Nurture | V2 | Login Sequence", url: "https://app.hubspot.com/workflows/8588479/platform/flow/1863237997/edit", group: "Customers" },
];

export async function GET() {
  const rows = NURTURE_WORKFLOWS.map((w, i) => ({
    id: String(i),
    name: w.name,
    hubspotUrl: w.url,
    group: w.group,
    status: "active" as const,
  }));

  return NextResponse.json({
    status: "ok",
    matchedCount: rows.length,
    rows,
  });
}
