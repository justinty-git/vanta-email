"use client";

import { useState } from "react";

type LookupResult = {
  id: string;
  name: string;
  meta: string;
  state: string;
};

type EmailMetrics = {
  sent: number;
  delivered: number;
  opens: number;
  clicks: number;
  openRate: number | null;
  clickRate: number | null;
};

function formatPercent(value: number | null) {
  if (value === null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export default function HealthLookup() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const [selected, setSelected] = useState<LookupResult | null>(null);
  const [metrics, setMetrics] = useState<EmailMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  async function runSearch(value: string) {
    setQuery(value);
    setSelected(null);
    setMetrics(null);
    setMetricsError(null);

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

  async function selectResult(result: LookupResult) {
    setSelected(result);
    setMetrics(null);
    setMetricsError(null);
    setMetricsLoading(true);

    try {
      const res = await fetch(
        `/api/hubspot/email-stats?emailId=${encodeURIComponent(result.id)}`
      );
      const data = await res.json();

      if (data.status === "error") {
        setMetricsError(data.message);
      } else {
        setMetrics(data.metrics);
      }
    } catch (err) {
      setMetricsError("Couldn't load stats for this email. Try again.");
    } finally {
      setMetricsLoading(false);
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
        maxWidth: 560,
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
            <button
              key={r.id}
              onClick={() => selectResult(r)}
              style={{
                display: "flex",
                width: "100%",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "9px 12px",
                borderBottom: "1px solid var(--border-table)",
                background:
                  selected?.id === r.id ? "var(--bg-card-alt)" : "transparent",
                border: "none",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "var(--border-table)",
                cursor: "pointer",
                textAlign: "left",
                font: "inherit",
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
            </button>
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

      {selected && (
        <div style={{ marginTop: 14 }}>
          <div
            style={{
              fontSize: "0.8125rem",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: 8,
            }}
          >
            {selected.name}{" "}
            <span style={{ fontWeight: 400, color: "var(--text-tertiary)" }}>
              · {selected.state} · {selected.meta}
            </span>
          </div>

          {metricsLoading && (
            <div
              style={{
                fontSize: "0.8125rem",
                color: "var(--text-tertiary)",
                padding: "10px 0",
              }}
            >
              Loading stats…
            </div>
          )}

          {!metricsLoading && metricsError && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 9,
                padding: "10px 12px",
                background: "var(--badge-danger-bg)",
                borderRadius: "var(--r-md)",
              }}
            >
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--badge-danger-text)",
                  lineHeight: 1.5,
                }}
              >
                {metricsError}
              </div>
            </div>
          )}

          {!metricsLoading && !metricsError && metrics && (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,1fr)",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    background: "var(--bg-card-alt)",
                    borderRadius: "var(--r-md)",
                    padding: 12,
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      color: "var(--text-secondary)",
                      marginBottom: 4,
                    }}
                  >
                    Delivered
                  </div>
                  <div
                    style={{
                      fontSize: "1.125rem",
                      fontWeight: 600,
                      color: "var(--text-primary)",
                    }}
                  >
                    {metrics.delivered.toLocaleString()}
                  </div>
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      color: "var(--text-tertiary)",
                      marginTop: 2,
                    }}
                  >
                    of {metrics.sent.toLocaleString()} sent
                  </div>
                </div>

                <div
                  style={{
                    background: "var(--bg-card-alt)",
                    borderRadius: "var(--r-md)",
                    padding: 12,
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      color: "var(--text-secondary)",
                      marginBottom: 4,
                    }}
                  >
                    Open Rate
                  </div>
                  <div
                    style={{
                      fontSize: "1.125rem",
                      fontWeight: 600,
                      color: "var(--dataviz-primary)",
                    }}
                  >
                    {formatPercent(metrics.openRate)}
                  </div>
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      color: "var(--text-tertiary)",
                      marginTop: 2,
                    }}
                  >
                    {metrics.opens.toLocaleString()} opens
                  </div>
                </div>

                <div
                  style={{
                    background: "var(--bg-card-alt)",
                    borderRadius: "var(--r-md)",
                    padding: 12,
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      color: "var(--text-secondary)",
                      marginBottom: 4,
                    }}
                  >
                    Click Rate
                  </div>
                  <div
                    style={{
                      fontSize: "1.125rem",
                      fontWeight: 600,
                      color: "var(--dataviz-primary)",
                    }}
                  >
                    {formatPercent(metrics.clickRate)}
                  </div>
                  <div
                    style={{
                      fontSize: "0.6875rem",
                      color: "var(--text-tertiary)",
                      marginTop: 2,
                    }}
                  >
                    {metrics.clicks.toLocaleString()} clicks
                  </div>
                </div>
              </div>

              {metrics.sent === 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 9,
                    marginTop: 12,
                    padding: "10px 12px",
                    background: "var(--badge-warning-bg)",
                    borderRadius: "var(--r-md)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--badge-warning-text)",
                      lineHeight: 1.5,
                    }}
                  >
                    This email hasn&rsquo;t sent yet — no stats are available
                    until it goes out.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
