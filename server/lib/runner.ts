import { ssrfSafeFetch } from "@agent-native/core/extensions/url-safety";

import {
  type CompiledContractGuard,
  evaluateContractGuard,
} from "./contract-guard.js";
import { handleSandboxRequest } from "./sandbox-apis.js";
import { redactSecrets, substituteSecrets } from "./target-secrets.js";

export interface EndpointTarget {
  id: string;
  name: string;
  method: string;
  targetUrl: string;
  headersJson: string;
  expectedStatus: number;
  maxLatencyMs: number;
  contractZodSchema: string;
}

export interface ScenarioInput {
  id: string;
  title: string;
  category: string;
  headersJson: string;
  bodyJson: string;
  expectedStatus: number;
}

export type Verdict = "passed" | "bug_exposed" | "assertion_failed";

export interface ScenarioExecutionResult {
  /** 0 when the request never got an HTTP response (DNS, TLS, timeout, SSRF block). */
  httpCode: number;
  latencyMs: number;
  responseJson: string;
  verdict: Verdict;
  bugSummary: string | null;
}

const EXTERNAL_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_STORED_RESPONSE_CHARS = 3_500;

export function safeParseJsonRecord(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Merges endpoint defaults with scenario overrides, case-insensitively (last write wins). */
function mergeHeaders(secrets: Record<string, string>, ...sources: string[]) {
  const merged = new Map<string, { name: string; value: string }>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(safeParseJsonRecord(source))) {
      if (value === undefined || value === null) continue;
      merged.set(name.toLowerCase(), { name, value: substituteSecrets(String(value), secrets) });
    }
  }
  const lower: Record<string, string> = {};
  const original: Record<string, string> = {};
  for (const [key, { name, value }] of merged) {
    lower[key] = value;
    original[name] = value;
  }
  return { lower, original };
}

type ParsedBody = { ok: true; value: unknown } | { ok: false; error: string };

function parseBody(raw: string): ParsedBody {
  if (!raw || !raw.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Invalid JSON" };
  }
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2).slice(0, MAX_STORED_RESPONSE_CHARS);
}

function elapsed(startedAt: number): number {
  return Math.max(1, Math.round(performance.now() - startedAt));
}

function judge(
  httpCode: number,
  latencyMs: number,
  endpoint: EndpointTarget,
  scenario: ScenarioInput,
  crashDetail: string | null,
): { verdict: Verdict; bugSummary: string | null } {
  const expected = scenario.expectedStatus;
  if (httpCode >= 500 && expected < 500) {
    return {
      verdict: "bug_exposed",
      bugSummary: crashDetail
        ? `500 Crash: ${crashDetail}`
        : `Server returned unhandled ${httpCode} on "${scenario.title}".`,
    };
  }
  if (httpCode !== expected) {
    const acceptedBadInput = expected >= 400 && expected < 500 && httpCode >= 200 && httpCode < 300;
    return {
      verdict: "assertion_failed",
      bugSummary: acceptedBadInput
        ? `API accepted input it should reject: expected HTTP ${expected}, received ${httpCode}.`
        : `Expected HTTP ${expected}, received ${httpCode}.`,
    };
  }
  if (latencyMs > endpoint.maxLatencyMs) {
    return {
      verdict: "assertion_failed",
      bugSummary: `Latency ${latencyMs}ms exceeded SLA budget of ${endpoint.maxLatencyMs}ms.`,
    };
  }
  return { verdict: "passed", bugSummary: null };
}

function finish(
  httpCode: number,
  latencyMs: number,
  responseJson: string,
  endpoint: EndpointTarget,
  scenario: ScenarioInput,
  crashDetail: string | null = null,
): ScenarioExecutionResult {
  return {
    httpCode,
    latencyMs,
    responseJson: responseJson || "{}",
    ...judge(httpCode, latencyMs, endpoint, scenario, crashDetail),
  };
}

/** Top stack frames, with absolute paths made project-relative. */
function stackFrames(err: Error): string[] {
  const cwd = process.cwd();
  return (err.stack ?? "")
    .split("\n")
    .slice(1, 5)
    .map((line) => line.trim().split(`${cwd}/`).join("").replace(/\?[^:)]*/g, ""));
}

async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_RESPONSE_BYTES - total;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** True for http(s) URLs on this machine: localhost, *.localhost, 127.0.0.0/8, ::1. */
export function isLoopbackTarget(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Local targets (your API on localhost) are allowed in development so you can
 * chaos-test the server you are building. In production the SSRF guard
 * always blocks them.
 */
export function localTargetsAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

export interface ExecuteOptions {
  /** Resolved values for `{{secret:KEY}}` header placeholders. */
  secrets?: Record<string, string>;
}

/**
 * Executes one scenario.
 *
 * Order: contract guard (gateway) → target. If the endpoint has a guard and the
 * request violates it, the request is rejected with 422 before it reaches the
 * target, exactly like validation middleware in front of the API.
 */
export async function executeScenarioAgainstEndpoint(
  endpoint: EndpointTarget,
  scenario: ScenarioInput,
  guard: CompiledContractGuard | null,
  options: ExecuteOptions = {},
): Promise<ScenarioExecutionResult> {
  const secrets = options.secrets ?? {};
  const result = await execute(endpoint, scenario, guard, secrets);
  if (!Object.keys(secrets).length) return result;
  return {
    ...result,
    responseJson: redactSecrets(result.responseJson, secrets),
    bugSummary: result.bugSummary ? redactSecrets(result.bugSummary, secrets) : null,
  };
}

async function execute(
  endpoint: EndpointTarget,
  scenario: ScenarioInput,
  guard: CompiledContractGuard | null,
  secrets: Record<string, string>,
): Promise<ScenarioExecutionResult> {
  const targetUrl = endpoint.targetUrl.trim();
  const isSandbox = targetUrl.startsWith("/sandbox/");
  const method = endpoint.method.toUpperCase();
  const headers = mergeHeaders(secrets, endpoint.headersJson, scenario.headersJson);
  const startedAt = performance.now();

  const body = parseBody(scenario.bodyJson);

  if (guard) {
    if (!body.ok) {
      return finish(
        400,
        elapsed(startedAt),
        pretty({ error: "invalid_json", guard: "ReqLab contract guard", message: body.error }),
        endpoint,
        scenario,
      );
    }
    const check = evaluateContractGuard(guard, { body: body.value, headers: headers.lower });
    if (!check.ok) {
      return finish(
        422,
        elapsed(startedAt),
        pretty({
          error: "contract_validation_failed",
          guard: "ReqLab contract guard",
          enforcedAt: isSandbox ? "sandbox middleware" : `gateway (request never reached ${targetUrl})`,
          issues: check.issues,
        }),
        endpoint,
        scenario,
      );
    }
  }

  if (isSandbox) {
    if (!body.ok) {
      return finish(
        400,
        elapsed(startedAt),
        pretty({ error: "invalid_json", message: body.error }),
        endpoint,
        scenario,
      );
    }
    try {
      const res = handleSandboxRequest({
        method,
        path: targetUrl,
        headers: headers.lower,
        body: body.value,
      });
      return finish(res.status, elapsed(startedAt), pretty(res.body), endpoint, scenario);
    } catch (thrown) {
      // Same behavior as an HTTP framework's last-resort error handler.
      const err = thrown instanceof Error ? thrown : new Error(String(thrown));
      const code = (err as Error & { code?: unknown }).code;
      return finish(
        500,
        elapsed(startedAt),
        pretty({
          error: err.name,
          message: err.message,
          ...(code !== undefined ? { code } : {}),
          stack: stackFrames(err),
        }),
        endpoint,
        scenario,
        `Unhandled ${err.name}: ${err.message}`,
      );
    }
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  const fetchHeaders =
    hasBody && !headers.lower["content-type"]
      ? { "content-type": "application/json", ...headers.original }
      : headers.original;
  const init: RequestInit = {
    method,
    headers: fetchHeaders,
    ...(hasBody ? { body: scenario.bodyJson } : {}),
    signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
  };
  const local = isLoopbackTarget(targetUrl) && localTargetsAllowed();
  try {
    // Local dev targets use a direct fetch with redirects disabled, so a local
    // server cannot bounce the request onto another private address.
    const response = local
      ? await fetch(targetUrl, { ...init, redirect: "manual" })
      : await ssrfSafeFetch(targetUrl, init);
    const { text, truncated } = await readCapped(response);
    const latencyMs = elapsed(startedAt);
    let formatted = text.slice(0, MAX_STORED_RESPONSE_CHARS);
    if (!truncated) {
      try {
        formatted = pretty(JSON.parse(text));
      } catch {
        // keep plain text
      }
    }
    return finish(response.status, latencyMs, formatted, endpoint, scenario);
  } catch (err) {
    const latencyMs = elapsed(startedAt);
    const message =
      err instanceof Error
        ? err.name === "TimeoutError"
          ? `No response within ${EXTERNAL_TIMEOUT_MS}ms`
          : err.message
        : "Network request failed";
    return {
      httpCode: 0,
      latencyMs,
      responseJson: pretty({ error: "request_failed", message }),
      verdict: "assertion_failed",
      bugSummary: `Request failed before an HTTP response: ${message}`,
    };
  }
}
