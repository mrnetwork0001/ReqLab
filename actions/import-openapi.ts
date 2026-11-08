import { ssrfSafeFetch } from "@agent-native/core/extensions/url-safety";
import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { parseOpenApi, parseSpecText } from "../server/lib/openapi-import.js";
import { isLoopbackTarget, localTargetsAllowed } from "../server/lib/runner.js";

const errors = defineActionErrors(
  "unauthorized",
  "fetch_failed",
  "invalid_spec",
  "blocked_target",
);

const FETCH_TIMEOUT_MS = 10_000;
const MAX_SPEC_BYTES = 5 * 1024 * 1024;
const MAX_ENDPOINTS = 40;

export default defineAction({
  description:
    "Import an OpenAPI 3.x or Swagger 2.0 spec from a URL (or pasted text) and create one ReqLab endpoint per operation, each seeded with a baseline sample request plus adversarial attack scenarios derived from its schema. Then run-scenarios or attack-batch on each endpoint. Skips endpoints that already exist (same method+URL). Requires sign-in.",
  schema: z
    .object({
      specUrl: z
        .string()
        .url()
        .optional()
        .describe("HTTPS URL of the OpenAPI/Swagger JSON or YAML document, e.g. https://petstore3.swagger.io/api/v3/openapi.json"),
      specText: z
        .string()
        .optional()
        .describe("Raw spec text (JSON or YAML), as an alternative to specUrl"),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_ENDPOINTS)
        .default(12)
        .describe(`Max operations to import (1–${MAX_ENDPOINTS}); defaults to 12`),
      seedAttacks: z
        .boolean()
        .default(true)
        .describe("Create the derived attack scenarios, not just the baseline; defaults to true"),
    })
    .refine((v) => v.specUrl || v.specText, {
      message: "Provide specUrl or specText.",
    }),
  outputSchema: z.object({
    apiTitle: z.string(),
    baseUrl: z.string(),
    createdEndpoints: z.number(),
    skippedEndpoints: z.number(),
    createdScenarios: z.number(),
    endpoints: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        method: z.string(),
        targetUrl: z.string(),
        scenarioCount: z.number(),
      }),
    ),
  }),
  errors,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  link: () => ({
    url: buildDeepLink({ view: "studio", to: "/studio" }),
    label: "Open Studio",
  }),
  run: async (args, ctx) => {
    const ownerEmail = ctx?.userEmail;
    if (!ownerEmail) {
      return errors.noWrite("Sign in to import a spec.", "unauthorized", { statusCode: 401 });
    }
    const orgId = ctx?.orgId ?? null;

    // 1. Obtain the spec text.
    let specText = args.specText ?? "";
    let fallbackBase = "https://localhost";
    if (args.specUrl) {
      const url = args.specUrl.trim();
      fallbackBase = url;
      const local = isLoopbackTarget(url);
      if (local && !localTargetsAllowed()) {
        return errors.noWrite("Local spec URLs are only allowed in development.", "blocked_target", {
          statusCode: 422,
        });
      }
      try {
        const response = local
          ? await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
          : await ssrfSafeFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) {
          return errors.noWrite(`Spec fetch returned HTTP ${response.status}.`, "fetch_failed", {
            statusCode: 422,
          });
        }
        const buf = await response.arrayBuffer();
        if (buf.byteLength > MAX_SPEC_BYTES) {
          return errors.noWrite("Spec document is larger than 5 MB.", "invalid_spec", { statusCode: 422 });
        }
        specText = Buffer.from(buf).toString("utf8");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Request failed";
        return errors.noWrite(`Could not fetch the spec: ${message}`, "fetch_failed", { statusCode: 422 });
      }
    }

    // 2. Parse it.
    const doc = parseSpecText(specText);
    if (!doc) {
      return errors.noWrite("Could not parse the document as JSON or YAML.", "invalid_spec", { statusCode: 422 });
    }
    const parsed = parseOpenApi(doc, fallbackBase);
    if (!parsed.ok) {
      return errors.noWrite(parsed.error, "invalid_spec", { statusCode: 422 });
    }

    // 3. Create endpoints (skip method+URL that already exist) and their scenarios.
    const { endpoints, endpointShares, testScenarios } = schema;
    const operations = parsed.operations.slice(0, args.limit);
    const now = new Date().toISOString();
    const created: Array<{ id: string; name: string; method: string; targetUrl: string; scenarioCount: number }> = [];
    let skipped = 0;
    let createdScenarios = 0;

    for (const op of operations) {
      const [existing] = await getDb()
        .select({ id: endpoints.id })
        .from(endpoints)
        .where(
          and(
            eq(endpoints.method, op.method),
            eq(endpoints.targetUrl, op.targetUrl),
            accessFilter(endpoints, endpointShares),
          ),
        )
        .limit(1);
      if (existing) {
        skipped++;
        continue;
      }

      const endpointId = crypto.randomUUID();
      await getDb().insert(endpoints).values({
        id: endpointId,
        name: op.name,
        method: op.method,
        targetUrl: op.targetUrl,
        headersJson: "{}",
        sampleBodyJson: op.sampleBodyJson,
        expectedStatus: op.expectedStatus,
        maxLatencyMs: 3000,
        contractZodSchema: "",
        notes: `Imported from ${parsed.title}`,
        lastRevisedBy: "agent",
        revisionCount: 1,
        createdAt: now,
        updatedAt: now,
        ownerEmail,
        orgId,
        visibility: orgId ? "org" : "private",
      });

      let scenarioCount = 0;
      // Baseline first, then the derived attacks.
      const rows = [
        {
          title: "Baseline (from spec sample)",
          category: "baseline" as const,
          headersJson: "{}",
          bodyJson: op.sampleBodyJson,
          expectedStatus: op.expectedStatus,
        },
        ...(args.seedAttacks ? op.attacks : []),
      ];
      const takenTitles = new Set<string>();
      for (const row of rows) {
        if (takenTitles.has(row.title)) continue;
        takenTitles.add(row.title);
        await getDb().insert(testScenarios).values({
          id: crypto.randomUUID(),
          endpointId,
          title: row.title,
          category: row.category,
          headersJson: row.headersJson,
          bodyJson: row.bodyJson,
          expectedStatus: row.expectedStatus,
          authoredBy: "agent",
          ownerEmail,
          orgId,
        });
        scenarioCount++;
        createdScenarios++;
      }

      created.push({ id: endpointId, name: op.name, method: op.method, targetUrl: op.targetUrl, scenarioCount });
    }

    return {
      apiTitle: parsed.title,
      baseUrl: parsed.baseUrl,
      createdEndpoints: created.length,
      skippedEndpoints: skipped,
      createdScenarios,
      endpoints: created,
    };
  },
});
