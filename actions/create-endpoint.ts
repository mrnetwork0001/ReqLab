import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  CONTRACT_GUARD_SYNTAX_HELP,
  compileContractGuard,
} from "../server/lib/contract-guard.js";

const errors = defineActionErrors(
  "unauthorized",
  "endpoint_conflict",
  "invalid_contract",
);

export default defineAction({
  description:
    "Create a new API or webhook endpoint in ReqLab. Rejects duplicate (method, targetUrl) with errorCode endpoint_conflict (409).",
  schema: z.object({
    name: z
      .string()
      .min(1)
      .describe('Human-readable endpoint name, e.g. "Checkout Charge API"'),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .default("POST")
      .describe(
        'HTTP method: "GET", "POST", "PUT", "PATCH", or "DELETE"; defaults to "POST"',
      ),
    targetUrl: z
      .string()
      .min(1)
      .describe(
        'Target path or HTTPS URL, e.g. "/sandbox/checkout" or "https://jsonplaceholder.typicode.com/posts"',
      ),
    headersJson: z
      .string()
      .default("{}")
      .describe('Default request headers as JSON object string; defaults to "{}"'),
    sampleBodyJson: z
      .string()
      .default("{}")
      .describe('Baseline JSON request body string; defaults to "{}"'),
    expectedStatus: z.coerce
      .number()
      .int()
      .min(100)
      .max(599)
      .default(200)
      .describe("Expected baseline HTTP status code; defaults to 200"),
    maxLatencyMs: z.coerce
      .number()
      .int()
      .min(10)
      .max(30000)
      .default(800)
      .describe("SLA latency budget in milliseconds; defaults to 800"),
    contractZodSchema: z
      .string()
      .default("")
      .describe(
        `Optional Zod contract guard; defaults to empty string. ${CONTRACT_GUARD_SYNTAX_HELP}`,
      ),
    notes: z
      .string()
      .default("")
      .describe("Engineering notes or SLA context; defaults to empty string"),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    method: z.string(),
    targetUrl: z.string(),
  }),
  errors,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  link: ({ result }) => ({
    url: buildDeepLink({
      view: "studio",
      to: `/studio/${encodeURIComponent(result.id)}`,
      params: { endpointId: result.id },
    }),
    label: `Open ${result.name}`,
  }),
  run: async (args, ctx) => {
    const ownerEmail = ctx?.userEmail;
    if (!ownerEmail) {
      return errors.noWrite("Sign in to create endpoints.", "unauthorized", {
        statusCode: 401,
      });
    }
    const orgId = ctx?.orgId ?? null;
    if (args.contractZodSchema !== undefined) {
      const compiled = compileContractGuard(args.contractZodSchema);
      if (!compiled.ok) {
        return errors.noWrite(
          `Contract guard does not compile: ${compiled.error}`,
          "invalid_contract",
          { statusCode: 422 },
        );
      }
    }
    const targetUrl = args.targetUrl.trim();
    const method = args.method.toUpperCase();

    return getDb().transaction(async (tx) => {
      const { endpoints, endpointShares, testScenarios } = schema;
      const [existing] = await tx
        .select({
          id: endpoints.id,
          name: endpoints.name,
        })
        .from(endpoints)
        .where(
          and(
            eq(endpoints.method, method),
            eq(endpoints.targetUrl, targetUrl),
            accessFilter(endpoints, endpointShares),
          ),
        )
        .limit(1);

      if (existing) {
        return errors.noWrite(
          `Endpoint ${method} ${targetUrl} already exists as "${existing.name}".`,
          "endpoint_conflict",
          {
            statusCode: 409,
            details: { conflictId: existing.id },
          },
        );
      }

      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await tx.insert(endpoints).values({
        id,
        name: args.name.trim(),
        method,
        targetUrl,
        headersJson: args.headersJson,
        sampleBodyJson: args.sampleBodyJson,
        expectedStatus: args.expectedStatus,
        maxLatencyMs: args.maxLatencyMs,
        contractZodSchema: args.contractZodSchema,
        notes: args.notes,
        lastRevisedBy: "human",
        revisionCount: 1,
        createdAt: now,
        updatedAt: now,
        ownerEmail,
        orgId,
        visibility: orgId ? "org" : "private",
      });

      await tx.insert(testScenarios).values({
        id: crypto.randomUUID(),
        endpointId: id,
        title: "Baseline Happy Path",
        category: "baseline",
        headersJson: args.headersJson,
        bodyJson: args.sampleBodyJson,
        expectedStatus: args.expectedStatus,
        lastVerdict: "untested",
        authoredBy: "human",
        ownerEmail,
        orgId,
        createdAt: now,
      });

      return {
        id,
        name: args.name.trim(),
        method,
        targetUrl,
      };
    });
  },
});
