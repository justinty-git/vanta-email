# Email Ready Room

Command Center for Email — Vanta Marketing Ops.

## What changed in this pass

This converts Ready Room from a static HTML export (zipped/redeployed each
session) into a real Next.js app with a git history, so it can grow real
server-side features — starting with live HubSpot data.

- `app/page.tsx` — currently embeds the existing design (`public/legacy/`) via
  iframe, so the live app looks identical to what's deployed today. This is an
  interim step, not the end state — see "Migration plan" below.
- `app/api/hubspot/*` — three new server-side API routes, one per planned live
  feature (Send Conflict Detector, Workflow Watchdog, Health Lookup). Each
  currently returns a placeholder HubSpot API call so you can confirm the
  token and connection work end to end before building the real logic.
- `lib/hubspot.ts` — shared helper that reads `HUBSPOT_TOKEN` server-side only.
  Never imported from a Client Component; the token never reaches the browser.

## Local setup

```bash
npm install
cp .env.example .env.local
# edit .env.local and paste your HubSpot Service Key token
npm run dev
```

Visit `http://localhost:3000` — should look identical to the current
deployed site. Visit `http://localhost:3000/api/hubspot/conflicts` (etc.) to
confirm each API route successfully reaches HubSpot.

## Deploying

This is meant to replace the current static deploy in place, same repo,
same Vercel project (`vantacom/vanta-email`), same URL.

```bash
git add -A
git commit -m "Convert Ready Room to Next.js app with HubSpot API routes"
git push
```

Vercel should auto-detect this as a Next.js project on the next push (it was
previously a static site, so double-check the build settings under
Project Settings → Build & Deployment show Framework Preset: Next.js after
the first deploy from this commit).

**Before this will work in production:** confirm `HUBSPOT_TOKEN` is set under
Project Settings → Environment Variables → Production. If you already added
it there from the Service Key setup, no action needed.

## Migration plan (panel by panel)

Don't rewrite the whole legacy export at once. For each feature, in this
order:

1. **Health Lookup** — ✅ done, live at `/health-lookup` (standalone preview,
   not yet merged into the main tab layout). Search finds real sent/scheduled
   emails by name; clicking a result pulls real stats (delivered, open rate,
   click rate) from `/api/hubspot/email-stats`.
2. **Workflow Watchdog** (read-only status list) — not started
3. **Send Conflict Detector** (most complex — cross-references multiple
   scheduled emails against list membership) — API route proven working
   (`/api/hubspot/conflicts` returns real scheduled emails), actual
   conflict-detection logic (comparing dates + audience overlap) not yet
   built

For each: replace the corresponding section inside `public/legacy/index.html`
with a real React component in `app/`, wired to fetch from its
`app/api/hubspot/*` route. Once a panel is migrated, its old markup can be
deleted from the legacy export.

**Next concrete step:** merge `app/health-lookup/HealthLookup.tsx` into the
real Health tab in `app/page.tsx` (replacing the "Needs connector" placeholder
that currently lives in `public/legacy/index.html`), instead of it living on
its own separate `/health-lookup` route.
