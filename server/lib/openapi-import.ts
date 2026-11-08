/**
 * Parses an OpenAPI 3.x (or Swagger 2.0) document into a flat list of
 * operations ReqLab can create as endpoints, plus a sample request body and a
 * first wave of adversarial attacks derived from each operation's schema.
 *
 * This is a pragmatic reader, not a full validator: it resolves local $ref,
 * handles the common schema shapes (object/array/string/number/integer/
 * boolean/enum, required, allOf), and ignores what it does not understand.
 */
import { parse as parseYaml } from "yaml";

export interface ImportedAttack {
  title: string;
  category: "boundary" | "injection" | "schema-fuzz" | "auth";
  headersJson: string;
  bodyJson: string;
  expectedStatus: number;
}

export interface ImportedOperation {
  method: string;
  path: string;
  targetUrl: string;
  name: string;
  expectedStatus: number;
  sampleBodyJson: string;
  attacks: ImportedAttack[];
}

export type OpenApiParseResult =
  | { ok: true; title: string; baseUrl: string; operations: ImportedOperation[] }
  | { ok: false; error: string };

type Json = Record<string, unknown>;

const METHODS = ["get", "post", "put", "patch", "delete"];
const MAX_OPERATIONS = 40;
const MAX_DEPTH = 6;

export function parseSpecText(text: string): Json | null {
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;
  } catch {
    // fall through to YAML
  }
  try {
    const parsed = parseYaml(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

function resolveRef(root: Json, node: unknown, depth = 0): unknown {
  if (depth > 12 || !node || typeof node !== "object") return node;
  const ref = (node as Json).$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    const parts = ref.slice(2).split("/");
    let current: unknown = root;
    for (const part of parts) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (current && typeof current === "object") current = (current as Json)[key];
      else return undefined;
    }
    return resolveRef(root, current, depth + 1);
  }
  return node;
}

function mergeAllOf(root: Json, schema: Json): Json {
  const allOf = schema.allOf;
  if (!Array.isArray(allOf)) return schema;
  const merged: Json = { type: "object", properties: {}, required: [] as string[] };
  for (const part of allOf) {
    const resolved = resolveRef(root, part) as Json | undefined;
    if (!resolved) continue;
    Object.assign(merged.properties as Json, (resolved.properties as Json) ?? {});
    if (Array.isArray(resolved.required)) {
      (merged.required as string[]).push(...(resolved.required as string[]));
    }
  }
  Object.assign(merged.properties as Json, (schema.properties as Json) ?? {});
  if (Array.isArray(schema.required)) (merged.required as string[]).push(...(schema.required as string[]));
  return merged;
}

/** A plausible valid value for a schema, used as the baseline sample body. */
function sampleValue(root: Json, rawSchema: unknown, depth = 0): unknown {
  const schema = resolveRef(root, rawSchema) as Json | undefined;
  if (!schema || depth > MAX_DEPTH) return "sample";
  const resolved = schema.allOf ? mergeAllOf(root, schema) : schema;
  if (resolved.example !== undefined) return resolved.example;
  if (Array.isArray(resolved.enum) && resolved.enum.length) return resolved.enum[0];
  const type = (resolved.type as string) ?? (resolved.properties ? "object" : "string");
  switch (type) {
    case "object": {
      const out: Json = {};
      const props = (resolved.properties as Json) ?? {};
      for (const [key, value] of Object.entries(props)) out[key] = sampleValue(root, value, depth + 1);
      return out;
    }
    case "array":
      return [sampleValue(root, resolved.items, depth + 1)];
    case "integer":
    case "number":
      return typeof resolved.minimum === "number" ? resolved.minimum : 1;
    case "boolean":
      return true;
    case "string":
      if (resolved.format === "date-time") return "2026-01-01T00:00:00Z";
      if (resolved.format === "email") return "user@example.com";
      if (resolved.format === "uuid") return "00000000-0000-0000-0000-000000000000";
      return "sample";
    default:
      return "sample";
  }
}

function requestSchema(root: Json, op: Json): Json | undefined {
  const body = resolveRef(root, op.requestBody) as Json | undefined;
  const content = body?.content as Json | undefined;
  const json = content?.["application/json"] as Json | undefined;
  const schema = resolveRef(root, json?.schema) as Json | undefined;
  if (!schema) return undefined;
  return schema.allOf ? mergeAllOf(root, schema) : schema;
}

function successStatus(op: Json, method: string): number {
  const responses = (op.responses as Json) ?? {};
  const codes = Object.keys(responses)
    .map((code) => Number(code))
    .filter((code) => code >= 200 && code < 300);
  if (codes.length) return Math.min(...codes);
  return method === "post" ? 201 : 200;
}

/** Attacks derived from a request body schema: each should be rejected (4xx). */
function deriveAttacks(root: Json, schema: Json | undefined, baseline: unknown): ImportedAttack[] {
  const attacks: ImportedAttack[] = [];
  const reject = 422;
  const push = (title: string, category: ImportedAttack["category"], body: unknown) =>
    attacks.push({ title, category, headersJson: "{}", bodyJson: JSON.stringify(body), expectedStatus: reject });

  // Always-useful shape attacks.
  push("Empty body", "schema-fuzz", {});
  push("Array instead of object", "schema-fuzz", [1, 2, 3]);

  if (schema && schema.type === "object" && schema.properties) {
    const props = schema.properties as Json;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const base = (baseline && typeof baseline === "object" && !Array.isArray(baseline) ? baseline : {}) as Json;

    if (required.length) {
      const withoutRequired = { ...base };
      delete withoutRequired[required[0]!];
      push(`Missing required "${required[0]}"`, "boundary", withoutRequired);
    }

    for (const [key, value] of Object.entries(props).slice(0, 4)) {
      const field = resolveRef(root, value) as Json | undefined;
      const type = field?.type as string | undefined;
      if (type === "integer" || type === "number") {
        push(`Negative "${key}"`, "boundary", { ...base, [key]: -999999 });
        push(`String in numeric "${key}"`, "schema-fuzz", { ...base, [key]: "NaN" });
      } else if (type === "string") {
        push(`Array in string "${key}"`, "schema-fuzz", { ...base, [key]: ["x", "y"] });
        push(`Injection in "${key}"`, "injection", { ...base, [key]: "a' OR '1'='1" });
        push(`Oversized "${key}"`, "boundary", { ...base, [key]: "A".repeat(10000) });
      } else if (type === "boolean") {
        push(`Non-boolean "${key}"`, "schema-fuzz", { ...base, [key]: "maybe" });
      } else if (Array.isArray(field?.enum)) {
        push(`Out-of-enum "${key}"`, "boundary", { ...base, [key]: "__not_a_valid_enum__" });
      }
      if (required.includes(key)) {
        push(`Null required "${key}"`, "schema-fuzz", { ...base, [key]: null });
      }
    }
  }

  // De-dup by title and cap.
  const seen = new Set<string>();
  return attacks.filter((a) => (seen.has(a.title) ? false : (seen.add(a.title), true))).slice(0, 8);
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function parseOpenApi(doc: Json, fallbackBaseUrl: string): OpenApiParseResult {
  const paths = doc.paths as Json | undefined;
  if (!paths || typeof paths !== "object") {
    return { ok: false, error: "No `paths` found — this does not look like an OpenAPI/Swagger document." };
  }

  // Resolve a base URL: OpenAPI 3 servers[0].url, or Swagger 2 host+basePath.
  let baseUrl = fallbackBaseUrl;
  const servers = doc.servers as Array<Json> | undefined;
  if (Array.isArray(servers) && servers[0]?.url) {
    const url = String(servers[0].url);
    baseUrl = url.startsWith("http") ? url : joinUrl(new URL(fallbackBaseUrl).origin, url);
  } else if (typeof doc.host === "string") {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.includes("https") ? "https" : "https";
    baseUrl = `${scheme}://${doc.host}${typeof doc.basePath === "string" ? doc.basePath : ""}`;
  }

  const title = ((doc.info as Json)?.title as string) ?? "Imported API";
  const operations: ImportedOperation[] = [];

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolveRef(doc, rawItem) as Json | undefined;
    if (!item) continue;
    for (const method of METHODS) {
      const op = item[method] as Json | undefined;
      if (!op) continue;
      if (operations.length >= MAX_OPERATIONS) break;
      const schema = requestSchema(doc, op);
      const hasBody = method !== "get" && method !== "delete" && Boolean(schema);
      const baseline = hasBody ? sampleValue(doc, schema, 0) : {};
      const summary = (op.summary as string) || (op.operationId as string) || path;
      operations.push({
        method: method.toUpperCase(),
        path,
        targetUrl: joinUrl(baseUrl, path),
        name: `${method.toUpperCase()} ${path} — ${summary}`.slice(0, 120),
        expectedStatus: successStatus(op, method),
        sampleBodyJson: hasBody ? JSON.stringify(baseline, null, 2) : "{}",
        attacks: hasBody ? deriveAttacks(doc, schema, baseline) : [],
      });
    }
  }

  if (!operations.length) {
    return { ok: false, error: "The document has `paths` but no GET/POST/PUT/PATCH/DELETE operations ReqLab can import." };
  }
  return { ok: true, title, baseUrl, operations };
}
