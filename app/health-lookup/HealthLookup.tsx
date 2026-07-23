"use client";

import { useState } from "react";

type LookupResult = {
  id: string;
  name: string;
  meta: string;
  state: string;
};

export default function HealthLookup() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function runSearch(value: string) {
    setQuery(value);

    if (!value.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/hubspot/health-lookup?query=${encodeURIComponent(value)}`
      );
      const data = await res.json();

      if (data.status === "error") {
        setError(data.message);
        setResults([]);
      } else {
        setResults(data.results || []);
      }
    } catch (err) {
      setError("Couldn't reach the lookup service. Try again.");
      setResults([]);
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border-card)",
        borderRadius: "var(--r-lg)",
        padding: "20px",
        boxShadow: "var(--shadow-card)",
        maxWidth: 520,
        fontFamily: "var(--font-base)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: "1.125rem",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          Email Health Lookup
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: "0.6875rem",
            fontWeight: 600,
            padding: "2px 9px",
            borderRadius: 999,
            background: "var(--badge-success-bg)",
            color: "var(--badge-success-text)",
            whiteSpace: "nowrap",
          }}
        >
          Live · HubSpot
        </span>
      </div>

      <div style={{ position: "relative" }}>
        <input
          type="text"
          value={query}
          onChange={(e) => runSearch(e.target.value)}
          placeholder="Search sent emails by name…"
          style={{
            width: "100%",
            padding: "9px 12px",
            borderRadius: "var(--r-sm)",
            border: "1px solid var(--border-card)",
            background: "var(--input-bg)",
            color: "var(--text-primary)",
            fontSize: "0.875rem",
          }}
        />
      </div>

      <div
        style={{
          marginTop: 8,
          maxHeight: 220,
          overflowY: "auto",
          border: "1px solid var(--border-table)",
          borderRadius: "var(--r-sm)",
        }}
      >
        {loading && (
          <div
            style={{
              padding: 14,
              fontSize: "0.8125rem",
              color: "var(--text-tertiary)",
              textAlign: "center",
            }}
          >
            Searching…
          </div>
        )}

        {!loading && error && (
          <div
            style={{
              padding: 14,
              fontSize: "0.8125rem",
              color: "var(--badge-danger-text)",
              textAlign: "center",
            }}
          >
            {error}
          </div>
        )}

        {!loading &&
          !error &&
          results.map((r) => (
            <div
              key={r.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "9px 12px",
                borderBottom: "1px solid var(--border-table)",
              }}
            >
              <span
                style={{
                  fontSize: "0.8125rem",
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.name}
              </span>
              <span
                style={{
                  fontSize: "0.6875rem",
                  color: "var(--text-tertiary)",
                  flexShrink: 0,
                }}
              >
                {r.state} · {r.meta}
              </span>
            </div>
          ))}

        {!loading && !error && searched && results.length === 0 && (
          <div
            style={{
              padding: 14,
              fontSize: "0.8125rem",
              color: "var(--text-tertiary)",
              textAlign: "center",
            }}
          >
            No sent emails match &ldquo;{query}&rdquo;.
          </div>
        )}
      </div>
    </div>
  );
}
