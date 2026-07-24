// INTERIM APPROACH
// -----------------
// The existing Ready Room design (public/legacy/index.html + support.js) was
// produced by Claude Design as a self-contained static export, not hand-written
// React components. Rather than hand-rewrite ~2,700 lines of markup/logic in one
// pass (high risk of visual regressions), this page embeds that export as-is via
// iframe so the live app keeps its current look immediately.
//
// The real migration path: as each panel (Send Conflict Detector, Health Lookup,
// Workflow Watchdog) gets wired to live HubSpot data, rebuild that ONE panel as a
// real React component fed by the API routes in app/api/hubspot/*, and remove the
// corresponding section from the legacy static export. Do this panel-by-panel
// rather than all at once.
//
// CACHE-BUSTING: public/ static assets can get cached (browser or CDN edge) at
// this exact URL. Since the URL never otherwise changes between deploys, a
// stale cached copy can keep being served even after a real code change ships.
// Appending a build-time version string forces a fresh fetch after every deploy.
const BUILD_VERSION = Date.now();

export default function Home() {
  return (
    <iframe
      src={`/legacy/index.html?v=${BUILD_VERSION}`}
      title="Email Ready Room"
      style={{
        border: "none",
        width: "100vw",
        height: "100vh",
        display: "block",
      }}
    />
  );
}
