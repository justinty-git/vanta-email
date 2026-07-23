// Server-side only. Never import this file from a Client Component.
// The token lives in Vercel's Environment Variables (HUBSPOT_TOKEN) —
// it is never sent to the browser.

const HUBSPOT_BASE_URL = "https://api.hubapi.com";

export async function hubspotFetch(path: string, init?: RequestInit) {
  const token = process.env.HUBSPOT_TOKEN;

  if (!token) {
    throw new Error(
      "HUBSPOT_TOKEN is not set. Add it in Vercel → Project Settings → Environment Variables."
    );
  }

  const res = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    // Marketing/workflow data doesn't need to be real-time to the second —
    // cache briefly to avoid hammering HubSpot's API on every page load.
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot API error ${res.status}: ${body}`);
  }

  return res.json();
}
