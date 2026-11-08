import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  exportContractGuard,
  GUARD_EXPORT_FRAMEWORKS,
} from "../server/lib/guard-export.js";

const errors = defineActionErrors("not_found", "no_contract");

export default defineAction({
  description:
    "Export an endpoint's Zod contract guard as ready-to-paste validation middleware (Express, Hono, or a framework-agnostic Fetch handler) so the fix ships in the real API, not just in ReqLab's gateway. Read-only.",
  schema: z.object({
    endpointId: z.string().min(1).describe("Endpoint id from list-endpoints"),
    framework: z
      .enum(GUARD_EXPORT_FRAMEWORKS)
      .default("express")
      .describe('Target framework: "express", "hono", or "fetch" (Next.js, Workers, Bun, Deno)'),
  }),
  outputSchema: z.object({
    endpointId: z.string(),
    framework: z.string(),
    filename: z.string(),
    mode: z.string(),
    code: z.string(),
  }),
  errors,
  http: { method: "GET" },
  readOnly: true,
  mcpAnnotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  run: async ({ endpointId, framework }) => {
    const { endpoints, endpointShares } = schema;
    const [endpoint] = await getDb()
      .select({
        id: endpoints.id,
        name: endpoints.name,
        method: endpoints.method,
        targetUrl: endpoints.targetUrl,
        contractZodSchema: endpoints.contractZodSchema,
      })
      .from(endpoints)
      .where(and(eq(endpoints.id, endpointId), accessFilter(endpoints, endpointShares)))
      .limit(1);

    if (!endpoint) {
      return errors.noWrite("Endpoint not found.", "not_found", { statusCode: 404 });
    }

    const exported = exportContractGuard({
      endpointName: endpoint.name,
      method: endpoint.method,
      targetUrl: endpoint.targetUrl,
      guardText: endpoint.contractZodSchema,
      framework,
    });
    if (!exported.ok) {
      return errors.noWrite(exported.error, "no_contract", { statusCode: 422 });
    }

    return {
      endpointId: endpoint.id,
      framework,
      filename: exported.filename,
      mode: exported.mode,
      code: exported.code,
    };
  },
});
