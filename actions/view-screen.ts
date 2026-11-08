import { defineAction } from "@agent-native/core/action";
import {
  readAppState,
  readAppStateForCurrentTab,
} from "@agent-native/core/application-state";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

export default defineAction({
  description:
    "Read ReqLab's current screen, open endpoint, selected chaos scenario, and visible test matrix state.",
  schema: z.object({}),
  http: false,
  readOnly: true,
  run: async () => {
    const navigation = (await readAppState("navigation")) as
      | Record<string, unknown>
      | undefined;
    const selection = await readAppStateForCurrentTab("selection");

    const screen: Record<string, unknown> = {};
    if (navigation) screen.navigation = navigation;
    if (selection) screen.selection = selection;

    const endpointId =
      typeof navigation?.endpointId === "string" ? navigation.endpointId : "";
    const scenarioId =
      typeof navigation?.scenarioId === "string" ? navigation.scenarioId : "";

    if (endpointId) {
      const { endpoints, endpointShares, testScenarios } = schema;
      const [endpoint] = await getDb()
        .select({
          id: endpoints.id,
          name: endpoints.name,
          method: endpoints.method,
          targetUrl: endpoints.targetUrl,
          expectedStatus: endpoints.expectedStatus,
          maxLatencyMs: endpoints.maxLatencyMs,
          contractZodSchema: endpoints.contractZodSchema,
          lastRevisedBy: endpoints.lastRevisedBy,
          revisionCount: endpoints.revisionCount,
        })
        .from(endpoints)
        .where(
          and(
            eq(endpoints.id, endpointId),
            accessFilter(endpoints, endpointShares),
          ),
        )
        .limit(1);

      if (endpoint) {
        const scenarios = await getDb()
          .select({
            id: testScenarios.id,
            title: testScenarios.title,
            category: testScenarios.category,
            expectedStatus: testScenarios.expectedStatus,
            lastHttpCode: testScenarios.lastHttpCode,
            lastVerdict: testScenarios.lastVerdict,
            bugSummary: testScenarios.bugSummary,
          })
          .from(testScenarios)
          .where(eq(testScenarios.endpointId, endpointId))
          .orderBy(testScenarios.createdAt)
          .limit(50);

        screen.openEndpoint = endpoint;
        screen.visibleScenarios = scenarios;
        if (scenarioId) {
          const focused = scenarios.find((s) => s.id === scenarioId);
          if (focused) screen.focusedScenario = focused;
        }
      }
    }

    if (Object.keys(screen).length === 0) {
      return "No application state found. Is the app running?";
    }
    return screen;
  },
});
