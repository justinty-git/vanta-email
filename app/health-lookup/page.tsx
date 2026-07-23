import HealthLookup from "./HealthLookup";

// This is a standalone preview route — the real Health Lookup component,
// wired to live HubSpot data, viewable on its own before it's merged into
// the main Ready Room tab layout (which still lives in public/legacy/).
//
// Once confirmed working, the next step is replacing the "Needs connector"
// placeholder panel inside public/legacy/index.html's Health tab with this
// component rendered directly in app/page.tsx.

export default function HealthLookupPreview() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-page)",
        padding: 40,
      }}
    >
      <div
        style={{
          fontSize: "0.75rem",
          color: "var(--text-tertiary)",
          marginBottom: 16,
          fontFamily: "var(--font-base)",
        }}
      >
        Standalone preview — real, live component, not yet merged into the
        main app.
      </div>
      <HealthLookup />
    </div>
  );
}
