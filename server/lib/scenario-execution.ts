/**
 * Shared "prepare, execute, record" path for every way a scenario runs: the
 * Chaos Matrix (run-scenarios) and Bug Hunt rounds (attack-batch).
 */
import { resolveSecretDetailed } from "@agent-native/core/server";
import { eq } from "drizzle-orm";

import { getDb, schema } from "../db/index.js";
import { type CompiledContractGuard, compileContractGuard } from "./contract-guard.js";
import { type EndpointTarget, executeScenarioAgainstEndpoint, type ScenarioInput } from "./runner.js";
import { findSecretReferences, isTargetSecretKey, TARGET_SECRET_KEYS } from "./target-secrets.js";

export type PrepareFailure = {
  ok: false;
  code: "invalid_contract" | "invalid_secret_ref" | "missing_secret" | "secret_lookup_failed";
  message: string;
  statusCode: number;
};

export type Prepared = {
  ok: true;
  guard: CompiledContractGuard | null;
  secrets: Record<string, string>;
};

/** Compiles the guard and resolves every `{{secret:KEY}}` the run will need. */
export async function prepareRun(
  endpoint: { contractZodSchema: string; headersJson: string },
  scenarioHeaders: string[],
): Promise<Prepared | PrepareFailure> {
  const compiled = compileContractGuard(endpoint.contractZodSchema);
  if (!compiled.ok) {
    return {
      ok: false,
      code: "invalid_contract",
      message: `The endpoint's contract guard does not compile: ${compiled.error}. Fix it with update-endpoint.`,
      statusCode: 422,
    };
  }

  const referenced = findSecretReferences(endpoint.headersJson, ...scenarioHeaders);
  const unknownRef = referenced.find((key) => !isTargetSecretKey(key));
  if (unknownRef) {
    return {
      ok: false,
      code: "invalid_secret_ref",
      message: `Headers reference {{secret:${unknownRef}}}, which ReqLab cannot use. Reference one of: ${TARGET_SECRET_KEYS.join(", ")}.`,
      statusCode: 422,
    };
  }
  const secrets: Record<string, string> = {};
  for (const key of referenced) {
    const detail = await resolveSecretDetailed(key);
    if (detail.lookupFailed) {
      return {
        ok: false,
        code: "secret_lookup_failed",
        message: `Could not read ${key} from the credential store. Try again.`,
        statusCode: 503,
      };
    }
    if (!detail.value) {
      return {
        ok: false,
        code: "missing_secret",
        message: `Headers reference {{secret:${key}}} but ${key} is not set. Add it in Settings → API keys, then re-run.`,
        statusCode: 422,
      };
    }
    secrets[key] = detail.value;
  }
  return { ok: true, guard: compiled.guard, secrets };
}

export interface RecordedResult {
  scenarioId: string;
  title: string;
  category: string;
  httpCode: number;
  latencyMs: number;
  verdict: string;
  bugSummary: string | null;
  responseJson: string;
}

/** Executes one scenario and records it on the scenario row and in the run log. */
export async function executeAndRecord(input: {
  target: EndpointTarget & { orgId: string | null };
  scenario: ScenarioInput;
  prepared: Prepared;
  ownerEmail: string;
  triggeredBy: "human" | "agent";
}): Promise<RecordedResult> {
  const { target, scenario, prepared } = input;
  const { testScenarios, scenarioRuns } = schema;
  const outcome = await executeScenarioAgainstEndpoint(target, scenario, prepared.guard, {
    secrets: prepared.secrets,
  });
  const executedAt = new Date().toISOString();

  await getDb()
    .update(testScenarios)
    .set({
      lastHttpCode: outcome.httpCode,
      lastLatencyMs: outcome.latencyMs,
      lastResponseJson: outcome.responseJson,
      lastVerdict: outcome.verdict,
      bugSummary: outcome.bugSummary,
      lastRunAt: executedAt,
    })
    .where(eq(testScenarios.id, scenario.id));

  await getDb().insert(scenarioRuns).values({
    id: crypto.randomUUID(),
    endpointId: target.id,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    httpCode: outcome.httpCode,
    latencyMs: outcome.latencyMs,
    verdict: outcome.verdict,
    responsePreview: outcome.responseJson.slice(0, 500),
    triggeredBy: input.triggeredBy,
    ownerEmail: input.ownerEmail,
    orgId: target.orgId,
    executedAt,
  });

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    category: scenario.category,
    httpCode: outcome.httpCode,
    latencyMs: outcome.latencyMs,
    verdict: outcome.verdict,
    bugSummary: outcome.bugSummary,
    responseJson: outcome.responseJson,
  };
}

/** Runs tasks with a fixed concurrency, keeping results in input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!, index);
      }
    }),
  );
  return results;
}
