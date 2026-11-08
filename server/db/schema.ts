import {
  createSharesTable,
  ownableColumns,
} from "@agent-native/core/db/schema";
import { sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

export const endpoints = pgTable("endpoints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  method: text("method").notNull().default("POST"),
  targetUrl: text("target_url").notNull(),
  headersJson: text("headers_json").notNull().default("{}"),
  sampleBodyJson: text("sample_body_json").notNull().default("{}"),
  expectedStatus: integer("expected_status").notNull().default(200),
  maxLatencyMs: integer("max_latency_ms").notNull().default(800),
  contractZodSchema: text("contract_zod_schema").notNull().default(""),
  notes: text("notes").notNull().default(""),
  lastRevisedBy: text("last_revised_by").notNull().default("human"),
  revisionCount: integer("revision_count").notNull().default(1),
  /** Secret path token for this endpoint's public webhook inbox; null until enabled. */
  inboxToken: text("inbox_token"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
  ...ownableColumns(),
});

export const endpointShares = createSharesTable("endpoint_shares");

export const testScenarios = pgTable("test_scenarios", {
  id: text("id").primaryKey(),
  endpointId: text("endpoint_id").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull().default("baseline"),
  headersJson: text("headers_json").notNull().default("{}"),
  bodyJson: text("body_json").notNull().default("{}"),
  expectedStatus: integer("expected_status").notNull().default(200),
  lastHttpCode: integer("last_http_code"),
  lastLatencyMs: integer("last_latency_ms"),
  lastResponseJson: text("last_response_json"),
  lastVerdict: text("last_verdict").notNull().default("untested"),
  bugSummary: text("bug_summary"),
  lastRunAt: text("last_run_at"),
  authoredBy: text("authored_by").notNull().default("human"),
  ownerEmail: text("owner_email").notNull(),
  orgId: text("org_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
});

export const scenarioRuns = pgTable("scenario_runs", {
  id: text("id").primaryKey(),
  endpointId: text("endpoint_id").notNull(),
  scenarioId: text("scenario_id").notNull(),
  scenarioTitle: text("scenario_title").notNull(),
  httpCode: integer("http_code").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  verdict: text("verdict").notNull(),
  responsePreview: text("response_preview").notNull(),
  triggeredBy: text("triggered_by").notNull().default("human"),
  ownerEmail: text("owner_email").notNull(),
  orgId: text("org_id"),
  executedAt: text("executed_at")
    .notNull()
    .default(sql`now()`),
});

/** Real inbound requests captured by an endpoint's webhook inbox (`/hooks/<token>`). */
export const webhookCaptures = pgTable("webhook_captures", {
  id: text("id").primaryKey(),
  endpointId: text("endpoint_id").notNull(),
  method: text("method").notNull(),
  headersJson: text("headers_json").notNull().default("{}"),
  bodyText: text("body_text").notNull().default(""),
  contentType: text("content_type").notNull().default(""),
  sizeBytes: integer("size_bytes").notNull().default(0),
  truncated: integer("truncated").notNull().default(0),
  sourceIp: text("source_ip").notNull().default(""),
  ownerEmail: text("owner_email").notNull(),
  orgId: text("org_id"),
  receivedAt: text("received_at")
    .notNull()
    .default(sql`now()`),
});
