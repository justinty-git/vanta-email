import { Signer } from "@aws-sdk/rds-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { Pool } from "pg";

// Aurora PostgreSQL connection using Vercel's OIDC Federation + RDS IAM
// authentication — confirmed via AWS's own Builder Center guide for
// this exact Vercel Marketplace integration (not guessed). This account
// has NO static password env var (checked the actual Environment
// Variables list: PGHOST, PGPORT, PGUSER, PGDATABASE, PGSSLMODE,
// AWS_ROLE_ARN, AWS_REGION, AWS_ACCOUNT_ID, AWS_RESOURCE_ARN — no
// PGPASSWORD), which is expected: this integration mints short-lived
// IAM auth tokens instead of using a long-lived stored credential.
//
// The Signer generates a fresh token per connection via the `password`
// callback below (pg's Pool/Client support an async function for
// `password`, specifically for this IAM-token pattern).

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;

  const signer = new Signer({
    hostname: process.env.PGHOST!,
    port: Number(process.env.PGPORT),
    username: process.env.PGUSER!,
    region: process.env.AWS_REGION!,
    credentials: awsCredentialsProvider({
      roleArn: process.env.AWS_ROLE_ARN!,
      clientConfig: { region: process.env.AWS_REGION! },
    }),
  });

  pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    database: process.env.PGDATABASE || "postgres",
    password: () => signer.getAuthToken(),
    ssl: { rejectUnauthorized: false }, // Aurora requires SSL; PGSSLMODE env var confirms this
  });

  return pool;
}

// Ensures the metric_snapshots table exists. One generic table for all
// snapshot-based metrics (Segment Health now, Underutilized Audience
// trend later) rather than a separate table per metric type — same
// shape (a label, a total, a "good" count, a rate, a date) fits both.
export async function ensureSchema(): Promise<void> {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id SERIAL PRIMARY KEY,
      metric_type TEXT NOT NULL,
      segment_label TEXT NOT NULL,
      total_count INTEGER,
      healthy_count INTEGER,
      rate NUMERIC,
      snapshot_date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (metric_type, segment_label, snapshot_date)
    )
  `);
  // Tracks which anomalies/conflicts have already been posted to Slack,
  // so a Critical anomaly that's still showing up 12 hours later
  // doesn't get re-posted as if it were new. item_key is a stable
  // identifier built from the underlying email/pair IDs — NOT the
  // display text (which can change slightly run to run, e.g. a
  // recomputed percentage).
  await db.query(`
    CREATE TABLE IF NOT EXISTS slack_alerts_sent (
      id SERIAL PRIMARY KEY,
      item_type TEXT NOT NULL,
      item_key TEXT NOT NULL,
      first_alerted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (item_type, item_key)
    )
  `);
}
