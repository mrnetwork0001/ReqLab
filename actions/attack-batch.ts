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

const CONCURRENCY = 4;
const MAX_ATTACKS = 8;

const attackSchema = z.object({
  title: z.string().min(1).describe('Short label, e.g. "Null id in update body"'),
  category: z
    .enum(["baseline", "boundary", "injection", "auth", "idempotency", "schema-fuzz"])
    .describe("Attack category"),
  hypothesis: z
    .string()
    .optional()
    .describe("One line on what you expect to break and why"),
  headersJson: z.string().default("{}").describe("Request headers as a JSON object string"),
  bodyJson: z.string().default("{}").describe("Request body (may be deliberately malformed)"),
  expectedStatus: z.coerce
    .number()
    .int()
    .min(100)
    .max(599)
    .describe("Status a correct API SHOULD return for this input (usually a 4xx for bad input)"),
});

/**
 * One Bug Hunt round: the agent proposes a batch of attacks, ReqLab persists
 * them as scenarios, runs them against the real target, and returns the real
 * outcomes so the agent can escalate on the next round. This is what makes the
 * hunt adaptive — the agent reads these results and designs the next batch.
 */
export default defineAction({
  description:
    "Bug Hunt round: persist a batch of adversarial attacks as scenarios on an endpoint, execute them against the live target, and return the real HTTP status, latency, verdict, and a response excerpt for each. Verdicts: bug_exposed = 5xx crash (a real bug), assertion_failed = wrong status (e.g. accepted bad input), passed = behaved as expected. Use the returned responseExcerpt and bugSummary to design a sharper next batch (escalate around whatever leaked a stack trace, accepted bad input, or behaved oddly). Duplicate-titled attacks are skipped, not failed. Requires editor access.",
  schema: z.object({
    endpointId: z.string().min(1).describe("Endpoint id from list-endpoints"),
    round: z.coerce.number().int().min(1).default(1).describe("1-based hunt round number, for labeling"),
    attacks: z.array(attackSchema).min(1).max(MAX_ATTACKS).describe(`1–${MAX_ATTACKS} attacks to try this round`),
  }),
  outputSchema: z.object({
    endpointId: z.string(),
    round: z.number(),
    attempted: z.number(),
    skippedDuplicates: z.number(),
    crashes: z.number(),
    mismatches: z.number(),
    passed: z.number(),
    results: z.array(
      z.object({
        scenarioId: z.string(),
        title: z.string(),
        category: z.string(),
        httpCode: z.number(),
        latencyMs: z.number(),
        verdict: z.string(),
        bugSummary: z.string().nullable(),
        responseExcerpt: z.string(),
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
    label: "Watch the Bug Hunt in Studio",
  }),
  run: async (args, ctx) => {
    const ownerEmail = ctx?.userEmail;
    if (!ownerEmail) {
      return errors.noWrite("Sign in to run a Bug Hunt.", "unauthorized", { statusCode: 401 });
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
      return errors.noWrite("Endpoint not found.", "not_found", { statusCode: 404 });
    }

    const prepared = await prepareRun(
      endpoint,
      args.attacks.map((attack) => attack.headersJson),
    );
    if (!prepared.ok) {
      return errors.noWrite(prepared.message, prepared.code, { statusCode: prepared.statusCode });
    }

    // Persist each attack as a scenario, skipping titles that already exist.
    const existing = await getDb()
      .select({ title: testScenarios.title })
      .from(testScenarios)
      .where(eq(testScenarios.endpointId, args.endpointId));
    const taken = new Set(existing.map((row) => row.title));

    const created: Array<{ id: string; title: string; category: string; headersJson: string; bodyJson: string; expectedStatus: number }> = [];
    let skippedDuplicates = 0;
    for (const attack of args.attacks) {
      const title = `R${args.round} · ${attack.title}`.slice(0, 160);
      if (taken.has(title)) {
        skippedDuplicates++;
        continue;
      }
      taken.add(title);
      const id = crypto.randomUUID();
      await getDb().insert(testScenarios).values({
        id,
        endpointId: args.endpointId,
        title,
        category: attack.category,
        headersJson: attack.headersJson,
        bodyJson: attack.bodyJson,
        expectedStatus: attack.expectedStatus,
        authoredBy: "agent",
        ownerEmail,
        orgId: endpoint.orgId,
      });
      created.push({ id, title, category: attack.category, headersJson: attack.headersJson, bodyJson: attack.bodyJson, expectedStatus: attack.expectedStatus });
    }

    const recorded = await mapWithConcurrency(created, CONCURRENCY, (scenario) =>
      executeAndRecord({
        target: endpoint,
        scenario,
        prepared,
        ownerEmail,
        triggeredBy: "agent",
      }),
    );

    const results = recorded.map((result) => ({
      scenarioId: result.scenarioId,
      title: result.title,
      category: result.category,
      httpCode: result.httpCode,
      latencyMs: result.latencyMs,
      verdict: result.verdict,
      bugSummary: result.bugSummary,
      responseExcerpt: result.responseJson.slice(0, 600),
    }));

    return {
      endpointId: endpoint.id,
      round: args.round,
      attempted: created.length,
      skippedDuplicates,
      crashes: results.filter((r) => r.verdict === "bug_exposed").length,
      mismatches: results.filter((r) => r.verdict === "assertion_failed").length,
      passed: results.filter((r) => r.verdict === "passed").length,
      results,
    };
  },
});
