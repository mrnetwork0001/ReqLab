import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const errors = defineActionErrors("not_found");

export default defineAction({
  description: "Delete a chaos or test scenario from an endpoint.",
  schema: z.object({
    id: z.string().min(1).describe("Scenario id to delete"),
  }),
  outputSchema: z.object({
    id: z.string(),
    endpointId: z.string(),
    deleted: z.boolean(),
  }),
  errors,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  run: async ({ id }) => {
    const { endpoints, endpointShares, testScenarios, scenarioRuns } = schema;
    const [scenario] = await getDb()
      .select({
        id: testScenarios.id,
        endpointId: testScenarios.endpointId,
      })
      .from(testScenarios)
      .where(eq(testScenarios.id, id))
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

    await getDb()
      .delete(scenarioRuns)
      .where(eq(scenarioRuns.scenarioId, id));
    await getDb().delete(testScenarios).where(eq(testScenarios.id, id));

    return {
      id: scenario.id,
      endpointId: scenario.endpointId,
      deleted: true,
    };
  },
});
