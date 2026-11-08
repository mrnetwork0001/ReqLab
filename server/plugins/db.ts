import { runMigrations } from "@agent-native/core/db";

export default runMigrations(
  [
    {
      version: 1,
      name: "reqlab-endpoints-scenarios-runs",
      sql: `CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST' CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  target_url TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}',
  sample_body_json TEXT NOT NULL DEFAULT '{}',
  expected_status INTEGER NOT NULL DEFAULT 200,
  max_latency_ms INTEGER NOT NULL DEFAULT 800,
  contract_zod_schema TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  last_revised_by TEXT NOT NULL DEFAULT 'human',
  revision_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE TABLE IF NOT EXISTS endpoint_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (now()),
  notified_at TEXT
);
CREATE TABLE IF NOT EXISTS test_scenarios (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'baseline' CHECK (category IN ('baseline', 'boundary', 'injection', 'auth', 'idempotency', 'schema-fuzz')),
  headers_json TEXT NOT NULL DEFAULT '{}',
  body_json TEXT NOT NULL DEFAULT '{}',
  expected_status INTEGER NOT NULL DEFAULT 200,
  last_http_code INTEGER,
  last_latency_ms INTEGER,
  last_response_json TEXT,
  last_verdict TEXT NOT NULL DEFAULT 'untested' CHECK (last_verdict IN ('untested', 'passed', 'bug_exposed', 'assertion_failed')),
  bug_summary TEXT,
  last_run_at TEXT,
  authored_by TEXT NOT NULL DEFAULT 'human',
  owner_email TEXT NOT NULL,
  org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (now())
);
CREATE TABLE IF NOT EXISTS scenario_runs (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL REFERENCES test_scenarios(id) ON DELETE CASCADE,
  scenario_title TEXT NOT NULL,
  http_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'bug_exposed', 'assertion_failed')),
  response_preview TEXT NOT NULL,
  triggered_by TEXT NOT NULL DEFAULT 'human',
  owner_email TEXT NOT NULL,
  org_id TEXT,
  executed_at TEXT NOT NULL DEFAULT (now())
);
CREATE INDEX IF NOT EXISTS endpoints_owner_org_idx ON endpoints (owner_email, org_id, name);
CREATE INDEX IF NOT EXISTS endpoint_shares_resource_idx ON endpoint_shares (resource_id, principal_type, principal_id);
CREATE INDEX IF NOT EXISTS test_scenarios_endpoint_idx ON test_scenarios (endpoint_id, created_at);
CREATE INDEX IF NOT EXISTS test_scenarios_org_endpoint_idx ON test_scenarios (org_id, endpoint_id);
CREATE INDEX IF NOT EXISTS scenario_runs_endpoint_executed_idx ON scenario_runs (endpoint_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS scenario_runs_org_endpoint_idx ON scenario_runs (org_id, endpoint_id);`,
    },
    {
      version: 2,
      name: "reqlab-webhook-inbox",
      sql: `ALTER TABLE endpoints ADD COLUMN IF NOT EXISTS inbox_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS endpoints_inbox_token_idx ON endpoints (inbox_token);
CREATE TABLE IF NOT EXISTS webhook_captures (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}',
  body_text TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  source_ip TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL,
  org_id TEXT,
  received_at TEXT NOT NULL DEFAULT (now())
);
CREATE INDEX IF NOT EXISTS webhook_captures_endpoint_received_idx ON webhook_captures (endpoint_id, received_at DESC);`,
    },
  ],
  { table: "reqlab_app_migrations" },
);
