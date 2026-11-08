import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const errors = defineActionErrors(
  "unauthorized",
  "not_found",
  "scenario_conflict",
);

export default defineAction({
  description:
    "Add a test or adversarial chaos scenario to an endpoint. Fails with scenario_conflict (409) if a scenario with the same title already exists on that endpoint.",
  schema: z.object({
    endpointId: z
      .string()
      .min(1)
      .describe("Endpoint id from list-endpoints"),
    title: z
      .string()
      .min(1)
      .describe('Scenario title, e.g. "Negative Quantity Underflow (-5)"'),
    category: z
      .enum([
        "baseline",
        "boundary",
        "injection",
        "auth",
        "idempotency",
        "schema-fuzz",
      ])
      .default("boundary")
      .describe(
        'Scenario category: "baseline", "boundary", "injection", "auth", "idempotency", or "schema-fuzz"; defaults to "boundary"',
      ),
    headersJson: z
      .string()
      .default("{}")
      .describe('Request header overrides as JSON object string; defaults to "{}"'),
    bodyJson: z
      .string()
      .default("{}")
      .describe('Request JSON payload string to send; defaults to "{}"'),
    expectedStatus: z.coerce
      .number()
      .int()
      .min(100)
      .max(599)
      .default(422)
      .describe(
        "Expected HTTP status code when properly guarded (e.g. 200 for baseline, 400/401/422 for adversarial input); defaults to 422",
      ),
    authoredBy: z
      .enum(["human", "agent"])
      .default("agent")
      .describe('Who created this scenario: "human" or "agent"; defaults to "agent"'),
  }),
  outputSchema: z.object({
    id: z.string(),
    endpointId: z.string(),
    title: z.string(),
    category: z.string(),
    expectedStatus: z.number(),
  }),
  errors,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  link: ({ args }) => ({
    url: buildDeepLink({
      view: "studio",
      to: `/studio/${encodeURIComponent(args.endpointId)}`,
      params: { endpointId: args.endpointId },
    }),
    label: "Open Endpoint Chaos Matrix",
  }),
  run: async (args, ctx) => {
    const ownerEmail = ctx?.userEmail;
    if (!ownerEmail) {
      return errors.noWrite("Sign in to add scenarios.", "unauthorized", {
        statusCode: 401,
      });
    }
    const cleanTitle = args.title.trim();

    return getDb().transaction(async (tx) => {
      const { endpoints, endpointShares, testScenarios } = schema;
      const [endpoint] = await tx
        .select({ id: endpoints.id, orgId: endpoints.orgId })
        .from(endpoints)
        .where(
          and(
            eq(endpoints.id, args.endpointId),
            accessFilter(endpoints, endpointShares, undefined, "editor"),
          ),
        )
        .for("update");

      if (!endpoint) {
        return errors.noWrite("Endpoint not found.", "not_found", {
          statusCode: 404,
        });
      }

      const [clash] = await tx
        .select({ id: testScenarios.id, title: testScenarios.title })
        .from(testScenarios)
        .where(
          and(
            eq(testScenarios.endpointId, args.endpointId),
            eq(testScenarios.title, cleanTitle),
          ),
        )
        .limit(1);

      if (clash) {
        return errors.noWrite(
          `Scenario "${cleanTitle}" already exists on this endpoint.`,
          "scenario_conflict",
          {
            statusCode: 409,
            details: { conflictId: clash.id },
          },
        );
      }

      const id = crypto.randomUUID();
      await tx.insert(testScenarios).values({
        id,
        endpointId: args.endpointId,
        title: cleanTitle,
        category: args.category,
        headersJson: args.headersJson,
        bodyJson: args.bodyJson,
        expectedStatus: args.expectedStatus,
        lastVerdict: "untested",
        authoredBy: args.authoredBy,
        ownerEmail,
        orgId: endpoint.orgId,
        createdAt: new Date().toISOString(),
      });

      return {
        id,
        endpointId: args.endpointId,
        title: cleanTitle,
        category: args.category,
        expectedStatus: args.expectedStatus,
      };
    });
  },
});
