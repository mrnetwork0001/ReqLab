import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const errors = defineActionErrors("not_found");

/** Transport headers that should not be replayed as part of a scenario. */
const NON_REPLAY_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "via",
  "forwarded",
  "x-real-ip",
  "cdn-loop",
]);

function replayHeaders(headersJson: string): string {
  let parsed: Record<string, string> = {};
  try {
    parsed = JSON.parse(headersJson) as Record<string, string>;
  } catch {
    return "{}";
  }
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const lower = name.toLowerCase();
    if (NON_REPLAY_HEADERS.has(lower) || lower.startsWith("x-forwarded-") || lower.startsWith("cf-")) {
      continue;
    }
    kept[lower] = String(value);
  }
  return JSON.stringify(kept, null, 2);
}

export default defineAction({
  description:
    "List real requests captured by an endpoint's webhook inbox, newest first, with headers and raw body. Each capture includes replayHeadersJson and bodyText ready to pass to create-scenario (headersJson, bodyJson) to turn a real delivery into a replayable chaos scenario. Read-only.",
  schema: z.object({
    endpointId: z.string().min(1).describe("Endpoint id from list-endpoints"),
    limit: z.coerce.number().int().min(1).max(50).default(20).describe("Max captures to return"),
  }),
  outputSchema: z.object({
    endpointId: z.string(),
    inboxPath: z.string().nullable(),
    captures: z.array(
      z.object({
        id: z.string(),
        method: z.string(),
        contentType: z.string(),
        sizeBytes: z.number(),
        truncated: z.boolean(),
        receivedAt: z.string(),
        headersJson: z.string(),
        replayHeadersJson: z.string(),
        bodyText: z.string(),
      }),
    ),
  }),
  errors,
  http: { method: "GET" },
  readOnly: true,
  mcpAnnotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  run: async ({ endpointId, limit }) => {
    const { endpoints, endpointShares, webhookCaptures } = schema;
    const [endpoint] = await getDb()
      .select({ id: endpoints.id, inboxToken: endpoints.inboxToken })
      .from(endpoints)
      .where(and(eq(endpoints.id, endpointId), accessFilter(endpoints, endpointShares)))
      .limit(1);
    if (!endpoint) {
      return errors.noWrite("Endpoint not found.", "not_found", { statusCode: 404 });
    }

    const rows = await getDb()
      .select()
      .from(webhookCaptures)
      .where(eq(webhookCaptures.endpointId, endpointId))
      .orderBy(desc(webhookCaptures.receivedAt))
      .limit(limit);

    return {
      endpointId,
      inboxPath: endpoint.inboxToken ? `/hooks/${endpoint.inboxToken}` : null,
      captures: rows.map((row) => ({
        id: row.id,
        method: row.method,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        truncated: row.truncated === 1,
        receivedAt: row.receivedAt,
        headersJson: row.headersJson,
        replayHeadersJson: replayHeaders(row.headersJson),
        bodyText: row.bodyText,
      })),
    };
  },
});
