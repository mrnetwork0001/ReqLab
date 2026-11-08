import { defineAction } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const endpointItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  method: z.string(),
  targetUrl: z.string(),
  expectedStatus: z.number(),
  maxLatencyMs: z.number(),
  hasContractGuard: z.boolean(),
  lastRevisedBy: z.string(),
  revisionCount: z.number(),
  totalScenarios: z.number(),
  passedCount: z.number(),
  bugsExposedCount: z.number(),
  assertionFailedCount: z.number(),
  untestedCount: z.number(),
});

export default defineAction({
  description:
    "List all API and webhook endpoints in ReqLab with chaos scenario pass/bug counts.",
  schema: z.object({}),
  outputSchema: z.object({
    endpoints: z.array(endpointItemSchema),
  }),
  http: { method: "GET" },
  readOnly: true,
  link: () => ({
    url: buildDeepLink({ view: "studio", to: "/studio" }),
    label: "Open ReqLab Studio",
  }),
  run: async () => {
    const { endpoints, endpointShares, testScenarios } = schema;
    const rows = await getDb()
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
      .where(accessFilter(endpoints, endpointShares))
      .orderBy(endpoints.name)
      .limit(100);

    const endpointIds = rows.map((r) => r.id);
    const scenarios =
      endpointIds.length > 0
        ? await getDb()
            .select({
              endpointId: testScenarios.endpointId,
              lastVerdict: testScenarios.lastVerdict,
            })
            .from(testScenarios)
            .where(inArray(testScenarios.endpointId, endpointIds))
            .limit(1000)
        : [];

    const enriched = rows.map((row) => {
      const belonging = scenarios.filter((s) => s.endpointId === row.id);
      return {
        id: row.id,
        name: row.name,
        method: row.method,
        targetUrl: row.targetUrl,
        expectedStatus: row.expectedStatus,
        maxLatencyMs: row.maxLatencyMs,
        hasContractGuard: Boolean(row.contractZodSchema.trim()),
        lastRevisedBy: row.lastRevisedBy,
        revisionCount: row.revisionCount,
        totalScenarios: belonging.length,
        passedCount: belonging.filter((s) => s.lastVerdict === "passed").length,
        bugsExposedCount: belonging.filter(
          (s) => s.lastVerdict === "bug_exposed",
        ).length,
        assertionFailedCount: belonging.filter(
          (s) => s.lastVerdict === "assertion_failed",
        ).length,
        untestedCount: belonging.filter((s) => s.lastVerdict === "untested")
          .length,
      };
    });

    return { endpoints: enriched };
  },
});
