import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const errors = defineActionErrors("not_found");

const scenarioSchema = z.object({
  id: z.string(),
  endpointId: z.string(),
  title: z.string(),
  category: z.string(),
  headersJson: z.string(),
  bodyJson: z.string(),
  expectedStatus: z.number(),
  lastHttpCode: z.number().nullable(),
  lastLatencyMs: z.number().nullable(),
  lastResponseJson: z.string().nullable(),
  lastVerdict: z.string(),
  bugSummary: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  authoredBy: z.string(),
});

const runItemSchema = z.object({
  id: z.string(),
  scenarioId: z.string(),
  scenarioTitle: z.string(),
  httpCode: z.number(),
  latencyMs: z.number(),
  verdict: z.string(),
  responsePreview: z.string(),
  triggeredBy: z.string(),
  executedAt: z.string(),
});

export default defineAction({
  description:
    "Get an API endpoint's full specification, contract schema, chaos test scenarios, and recent execution runs.",
  schema: z.object({
    id: z.string().min(1).describe("Endpoint id from list-endpoints"),
  }),
  outputSchema: z.object({
    endpoint: z.object({
      id: z.string(),
      name: z.string(),
      method: z.string(),
      targetUrl: z.string(),
      headersJson: z.string(),
      sampleBodyJson: z.string(),
      expectedStatus: z.number(),
      maxLatencyMs: z.number(),
      contractZodSchema: z.string(),
      notes: z.string(),
      lastRevisedBy: z.string(),
      revisionCount: z.number(),
      visibility: z.string(),
    }),
    scenarios: z.array(scenarioSchema),
    runs: z.array(runItemSchema),
  }),
  errors,
  http: { method: "GET" },
  readOnly: true,
  link: ({ args }) => ({
    url: buildDeepLink({
      view: "studio",
      to: `/studio/${encodeURIComponent(args.id)}`,
      params: { endpointId: args.id },
    }),
    label: "Open Endpoint in Studio",
  }),
  run: async ({ id }) => {
    const { endpoints, endpointShares, testScenarios, scenarioRuns } = schema;
    const [endpoint] = await getDb()
      .select({
        id: endpoints.id,
        name: endpoints.name,
        method: endpoints.method,
        targetUrl: endpoints.targetUrl,
        headersJson: endpoints.headersJson,
        sampleBodyJson: endpoints.sampleBodyJson,
        expectedStatus: endpoints.expectedStatus,
        maxLatencyMs: endpoints.maxLatencyMs,
        contractZodSchema: endpoints.contractZodSchema,
        notes: endpoints.notes,
        lastRevisedBy: endpoints.lastRevisedBy,
        revisionCount: endpoints.revisionCount,
        visibility: endpoints.visibility,
      })
      .from(endpoints)
      .where(and(eq(endpoints.id, id), accessFilter(endpoints, endpointShares)))
      .limit(1);

    if (!endpoint) {
      return errors.noWrite("Endpoint not found.", "not_found", {
        statusCode: 404,
      });
    }

    const scenarios = await getDb()
      .select({
        id: testScenarios.id,
        endpointId: testScenarios.endpointId,
        title: testScenarios.title,
        category: testScenarios.category,
        headersJson: testScenarios.headersJson,
        bodyJson: testScenarios.bodyJson,
        expectedStatus: testScenarios.expectedStatus,
        lastHttpCode: testScenarios.lastHttpCode,
        lastLatencyMs: testScenarios.lastLatencyMs,
        lastResponseJson: testScenarios.lastResponseJson,
        lastVerdict: testScenarios.lastVerdict,
        bugSummary: testScenarios.bugSummary,
        lastRunAt: testScenarios.lastRunAt,
        authoredBy: testScenarios.authoredBy,
      })
      .from(testScenarios)
      .where(eq(testScenarios.endpointId, id))
      .orderBy(testScenarios.createdAt)
      .limit(200);

    const runs = await getDb()
      .select({
        id: scenarioRuns.id,
        scenarioId: scenarioRuns.scenarioId,
        scenarioTitle: scenarioRuns.scenarioTitle,
        httpCode: scenarioRuns.httpCode,
        latencyMs: scenarioRuns.latencyMs,
        verdict: scenarioRuns.verdict,
        responsePreview: scenarioRuns.responsePreview,
        triggeredBy: scenarioRuns.triggeredBy,
        executedAt: scenarioRuns.executedAt,
      })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.endpointId, id))
      .orderBy(desc(scenarioRuns.executedAt))
      .limit(30);

    return {
      endpoint,
      scenarios,
      runs,
    };
  },
});
