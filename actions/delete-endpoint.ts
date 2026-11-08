import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const errors = defineActionErrors("not_found");

export default defineAction({
  description: "Delete an API endpoint with its chaos scenarios, run history, webhook captures, and shares. Requires editor access.",
  schema: z.object({
    id: z.string().min(1).describe("Endpoint id to delete"),
  }),
  outputSchema: z.object({
    id: z.string(),
    deleted: z.boolean(),
  }),
  errors,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  run: async ({ id }) => {
    const { endpoints, endpointShares, testScenarios, scenarioRuns, webhookCaptures } = schema;
    const [existing] = await getDb()
      .select({ id: endpoints.id })
      .from(endpoints)
      .where(and(eq(endpoints.id, id), accessFilter(endpoints, endpointShares, undefined, "editor")))
      .limit(1);

    if (!existing) {
      return errors.noWrite("Endpoint not found.", "not_found", {
        statusCode: 404,
      });
    }

    await getDb()
      .delete(scenarioRuns)
      .where(eq(scenarioRuns.endpointId, id));
    await getDb()
      .delete(testScenarios)
      .where(eq(testScenarios.endpointId, id));
    await getDb()
      .delete(webhookCaptures)
      .where(eq(webhookCaptures.endpointId, id));
    await getDb()
      .delete(endpointShares)
      .where(eq(endpointShares.resourceId, id));
    await getDb().delete(endpoints).where(eq(endpoints.id, id));

    return { id, deleted: true };
  },
});
