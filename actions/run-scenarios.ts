import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  executeAndRecord,
  mapWithConcurrency,
  prepareRun,
} from "../server/lib/scenario-execution.js";

const errors = defineActionErrors(
  "unauthorized",
  "not_found",
  "invalid_contract",
  "invalid_secret_ref",
  "missing_secret",
  "secret_lookup_failed",
);

/** Live HTTPS targets run a few scenarios at a time; sandbox targets are in-process. */
const RUN_CONCURRENCY = 4;

export default defineAction({
  description:
    "Execute either one specific scenario (by scenarioId) or the entire Chaos Matrix for an endpoint (by endpointId), recording HTTP status, latency, response JSON, and bug verdicts. Requires editor access. Header values may reference stored credentials as {{secret:REQLAB_TARGET_API_KEY}}, {{secret:REQLAB_TARGET_API_KEY_2}}, or {{secret:REQLAB_WEBHOOK_SIGNING_SECRET}}; they are resolved server-side and redacted from stored responses. missing_secret (422) means the user must add the key in Settings → API keys. Local targets (http://localhost:PORT) work in development.",
  schema: z.object({
    endpointId: z
      .string()
      .min(1)
      .describe("Endpoint id from list-endpoints"),
    scenarioId: z
      .string()
      .optional()
      .describe(
        "Optional single scenario id to run; omit to execute all scenarios on the endpoint",
      ),
    triggeredBy: z
      .enum(["human", "agent"])
      .default("agent")
      .describe('Who triggered this run: "human" or "agent"; defaults to "agent"'),
  }),
  outputSchema: z.object({
    endpointId: z.string(),
    totalExecuted: z.number(),
    passedCount: z.number(),
    bugsExposedCount: z.number(),
    assertionFailedCount: z.number(),
    results: z.array(
      z.object({
        scenarioId: z.string(),
        title: z.string(),
        category: z.string(),
        httpCode: z.number(),
        latencyMs: z.number(),
        verdict: z.string(),
        bugSummary: z.string().nullable(),
      }),
    ),
  }),
  errors,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  link: ({ args }) => ({
    url: buildDeepLink({
      view: "studio",
      to: `/studio/${encodeURIComponent(args.endpointId)}`,
      params: { endpointId: args.endpointId },
    }),
    label: "View Execution Results in Studio",
  }),
  run: async (args, ctx) => {
    const ownerEmail = ctx?.userEmail;
    if (!ownerEmail) {
      return errors.noWrite("Sign in to execute scenarios.", "unauthorized", {
        statusCode: 401,
      });
    }

    const { endpoints, endpointShares, testScenarios } = schema;
    const [endpoint] = await getDb()
      .select({
        id: endpoints.id,
        name: endpoints.name,
        method: endpoints.method,
        targetUrl: endpoints.targetUrl,
        headersJson: endpoints.headersJson,
        expectedStatus: endpoints.expectedStatus,
        maxLatencyMs: endpoints.maxLatencyMs,
        contractZodSchema: endpoints.contractZodSchema,
        orgId: endpoints.orgId,
      })
      .from(endpoints)
      .where(
        and(
          eq(endpoints.id, args.endpointId),
          accessFilter(endpoints, endpointShares, undefined, "editor"),
        ),
      )
      .limit(1);

    if (!endpoint) {
      return errors.noWrite("Endpoint not found.", "not_found", {
        statusCode: 404,
      });
    }

    const scenarioQuery = args.scenarioId
      ? and(
          eq(testScenarios.endpointId, args.endpointId),
          eq(testScenarios.id, args.scenarioId),
        )
      : eq(testScenarios.endpointId, args.endpointId);

    const scenarios = await getDb()
      .select({
        id: testScenarios.id,
        title: testScenarios.title,
        category: testScenarios.category,
        headersJson: testScenarios.headersJson,
        bodyJson: testScenarios.bodyJson,
        expectedStatus: testScenarios.expectedStatus,
      })
      .from(testScenarios)
      .where(scenarioQuery)
      .orderBy(testScenarios.createdAt)
      .limit(100);

    if (scenarios.length === 0) {
      return errors.noWrite(
        "No matching scenarios found for this endpoint.",
        "not_found",
        {
          statusCode: 404,
        },
      );
    }

    const prepared = await prepareRun(
      endpoint,
      scenarios.map((scenario) => scenario.headersJson),
    );
    if (!prepared.ok) {
      return errors.noWrite(prepared.message, prepared.code, {
        statusCode: prepared.statusCode,
      });
    }

    const target = endpoint;
    const recorded = await mapWithConcurrency(scenarios, RUN_CONCURRENCY, (scenario) =>
      executeAndRecord({
        target,
        scenario,
        prepared,
        ownerEmail,
        triggeredBy: args.triggeredBy,
      }),
    );
    const results = recorded.map(({ responseJson: _response, ...rest }) => rest);

    return {
      endpointId: endpoint.id,
      totalExecuted: results.length,
      passedCount: results.filter((r) => r.verdict === "passed").length,
      bugsExposedCount: results.filter((r) => r.verdict === "bug_exposed")
        .length,
      assertionFailedCount: results.filter(
        (r) => r.verdict === "assertion_failed",
      ).length,
      results,
    };
  },
});
