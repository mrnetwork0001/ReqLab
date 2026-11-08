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

const errors = defineActionErrors("not_found", "invalid_contract");

export default defineAction({
  description:
    "Update an endpoint's configuration, request template, SLA latency budget, or Zod contract guard schema.",
  schema: z.object({
    id: z.string().min(1).describe("Endpoint id to update"),
    name: z.string().min(1).optional().describe("Updated endpoint name"),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .optional()
      .describe('HTTP method: "GET", "POST", "PUT", "PATCH", or "DELETE"'),
    targetUrl: z.string().min(1).optional().describe("Updated target URL or sandbox path"),
    headersJson: z
      .string()
      .optional()
      .describe("Updated default headers JSON object string"),
    sampleBodyJson: z
      .string()
      .optional()
      .describe("Updated baseline sample body JSON string"),
    expectedStatus: z.coerce
      .number()
      .int()
      .min(100)
      .max(599)
      .optional()
      .describe("Updated expected HTTP status code"),
    maxLatencyMs: z.coerce
      .number()
      .int()
      .min(10)
      .max(30000)
      .optional()
      .describe("Updated max SLA latency in ms"),
    contractZodSchema: z
      .string()
      .optional()
      .describe(
        `Updated Zod contract guard; empty string removes it. ${CONTRACT_GUARD_SYNTAX_HELP}`,
      ),
    notes: z.string().optional().describe("Updated engineering notes"),
    revisedBy: z
      .enum(["human", "agent"])
      .default("agent")
      .describe('Who made this revision: "human" or "agent"; defaults to "agent"'),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    revisionCount: z.number(),
    lastRevisedBy: z.string(),
    hasContractGuard: z.boolean(),
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
  run: async (args) => {
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
    const { endpoints, endpointShares } = schema;
    const [existing] = await getDb()
      .select({
        id: endpoints.id,
        name: endpoints.name,
        revisionCount: endpoints.revisionCount,
        contractZodSchema: endpoints.contractZodSchema,
      })
      .from(endpoints)
      .where(
        and(eq(endpoints.id, args.id), accessFilter(endpoints, endpointShares, undefined, "editor")),
      )
      .limit(1);

    if (!existing) {
      return errors.noWrite("Endpoint not found.", "not_found", {
        statusCode: 404,
      });
    }

    const nextRevision = existing.revisionCount + 1;
    const nextContract =
      args.contractZodSchema !== undefined
        ? args.contractZodSchema
        : existing.contractZodSchema;

    const patch: Record<string, unknown> = {
      revisionCount: nextRevision,
      lastRevisedBy: args.revisedBy,
      updatedAt: new Date().toISOString(),
    };
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.method !== undefined) patch.method = args.method;
    if (args.targetUrl !== undefined) patch.targetUrl = args.targetUrl.trim();
    if (args.headersJson !== undefined) patch.headersJson = args.headersJson;
    if (args.sampleBodyJson !== undefined)
      patch.sampleBodyJson = args.sampleBodyJson;
    if (args.expectedStatus !== undefined)
      patch.expectedStatus = args.expectedStatus;
    if (args.maxLatencyMs !== undefined) patch.maxLatencyMs = args.maxLatencyMs;
    if (args.contractZodSchema !== undefined)
      patch.contractZodSchema = args.contractZodSchema;
    if (args.notes !== undefined) patch.notes = args.notes;

    await getDb()
      .update(endpoints)
      .set(patch)
      .where(eq(endpoints.id, args.id));

    return {
      id: existing.id,
      name: args.name?.trim() ?? existing.name,
      revisionCount: nextRevision,
      lastRevisedBy: args.revisedBy,
      hasContractGuard: Boolean(nextContract.trim()),
    };
  },
});
