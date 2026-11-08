import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const errors = defineActionErrors("not_found", "scenario_conflict", "invalid_headers");

export default defineAction({
  description:
    "Update an existing test or chaos scenario's title, category, headers, payload body, or expected status code. Requires editor access. Renaming to a title another scenario on the same endpoint already uses fails with scenario_conflict (409); headersJson must be a JSON object (invalid_headers, 422). bodyJson may be deliberately malformed for fuzzing.",
  schema: z.object({
    id: z.string().min(1).describe("Scenario id to update"),
    title: z.string().min(1).optional().describe("Updated scenario title"),
    category: z
      .enum([
        "baseline",
        "boundary",
        "injection",
        "auth",
        "idempotency",
        "schema-fuzz",
      ])
      .optional()
      .describe(
        'Updated category: "baseline", "boundary", "injection", "auth", "idempotency", or "schema-fuzz"',
      ),
    headersJson: z
      .string()
      .optional()
      .describe("Updated headers JSON object string"),
    bodyJson: z
      .string()
      .optional()
      .describe("Updated request payload JSON string"),
    expectedStatus: z.coerce
      .number()
      .int()
      .min(100)
      .max(599)
      .optional()
      .describe("Updated expected HTTP status code"),
    authoredBy: z
      .enum(["human", "agent"])
      .default("human")
      .describe('Who edited this scenario: "human" or "agent"; defaults to "human"'),
  }),
  outputSchema: z.object({
    id: z.string(),
    endpointId: z.string(),
    title: z.string(),
    expectedStatus: z.number(),
    authoredBy: z.string(),
  }),
  errors,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  run: async (args) => {
    const { endpoints, endpointShares, testScenarios } = schema;
    const [scenario] = await getDb()
      .select({
        id: testScenarios.id,
        endpointId: testScenarios.endpointId,
        title: testScenarios.title,
        expectedStatus: testScenarios.expectedStatus,
      })
      .from(testScenarios)
      .where(eq(testScenarios.id, args.id))
      .limit(1);

    if (!scenario) {
      return errors.noWrite("Scenario not found.", "not_found", {
        statusCode: 404,
      });
    }

    const [endpoint] = await getDb()
      .select({ id: endpoints.id })
      .from(endpoints)
      .where(
        and(
          eq(endpoints.id, scenario.endpointId),
          accessFilter(endpoints, endpointShares, undefined, "editor"),
        ),
      )
      .limit(1);

    if (!endpoint) {
      return errors.noWrite("Endpoint not found.", "not_found", {
        statusCode: 404,
      });
    }

    if (args.headersJson !== undefined && args.headersJson.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.headersJson);
      } catch {
        parsed = undefined;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return errors.noWrite(
          'headersJson must be a JSON object, e.g. {"authorization": "Bearer token"}.',
          "invalid_headers",
          { statusCode: 422 },
        );
      }
    }

    const nextTitle = args.title?.trim();
    if (nextTitle && nextTitle !== scenario.title) {
      const [clash] = await getDb()
        .select({ id: testScenarios.id })
        .from(testScenarios)
        .where(
          and(
            eq(testScenarios.endpointId, scenario.endpointId),
            eq(testScenarios.title, nextTitle),
            ne(testScenarios.id, scenario.id),
          ),
        )
        .limit(1);
      if (clash) {
        return errors.noWrite(
          `Another scenario on this endpoint is already titled "${nextTitle}".`,
          "scenario_conflict",
          { statusCode: 409 },
        );
      }
    }

    const patch: Record<string, unknown> = {
      authoredBy: args.authoredBy,
    };
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.category !== undefined) patch.category = args.category;
    if (args.headersJson !== undefined) patch.headersJson = args.headersJson;
    if (args.bodyJson !== undefined) patch.bodyJson = args.bodyJson;
    if (args.expectedStatus !== undefined)
      patch.expectedStatus = args.expectedStatus;

    await getDb()
      .update(testScenarios)
      .set(patch)
      .where(eq(testScenarios.id, args.id));

    return {
      id: scenario.id,
      endpointId: scenario.endpointId,
      title: args.title?.trim() ?? scenario.title,
      expectedStatus: args.expectedStatus ?? scenario.expectedStatus,
      authoredBy: args.authoredBy,
    };
  },
});
