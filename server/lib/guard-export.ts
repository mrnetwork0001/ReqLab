/**
 * Turns a ReqLab contract guard into validation middleware you can paste into
 * the real API, so the fix ships in your code instead of living only in
 * ReqLab's gateway. The guard text is real Zod source, so it is emitted as is.
 */
import { compileContractGuard } from "./contract-guard.js";

export const GUARD_EXPORT_FRAMEWORKS = ["express", "hono", "fetch"] as const;
export type GuardExportFramework = (typeof GUARD_EXPORT_FRAMEWORKS)[number];

export type GuardExportResult =
  | { ok: true; code: string; filename: string; mode: "body" | "envelope" }
  | { ok: false; error: string };

function identifierFrom(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, " ")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 4);
  const camel = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  const safe = /^[A-Za-z_]/.test(camel) ? camel : `api${camel}`;
  return safe || "api";
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .trim()
    .split("\n")
    .map((line, i) => (i === 0 ? line : pad + line.trimStart()))
    .join("\n");
}

export function exportContractGuard(input: {
  endpointName: string;
  method: string;
  targetUrl: string;
  guardText: string;
  framework: GuardExportFramework;
}): GuardExportResult {
  const compiled = compileContractGuard(input.guardText);
  if (!compiled.ok) return { ok: false, error: `Contract guard does not compile: ${compiled.error}` };
  if (!compiled.guard) return { ok: false, error: "This endpoint has no contract guard to export yet." };

  const mode = compiled.guard.mode;
  const base = identifierFrom(input.endpointName);
  const schemaName = `${base}Contract`;
  const guardName = `validate${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  const header = `// ReqLab contract guard for ${input.method.toUpperCase()} ${input.targetUrl}
// Generated from the guard that turned this endpoint's chaos crashes into 422s.
// Requires zod@4.
import { z } from "zod";`;
  const schema = `export const ${schemaName} = ${indent(input.guardText, 2)};`;
  const issues = `{ error: "contract_validation_failed", issues: result.error.issues }`;

  if (input.framework === "express") {
    const subject = mode === "envelope" ? "{ headers: req.headers, body: req.body }" : "req.body";
    const assign = mode === "envelope" ? "result.data.body" : "result.data";
    return {
      ok: true,
      mode,
      filename: `${base}-contract.express.ts`,
      code: `${header}
import type { RequestHandler } from "express";

${schema}

/** Mount before the route handler, after express.json(). */
export const ${guardName}: RequestHandler = (req, res, next) => {
  const result = ${schemaName}.safeParse(${subject});
  if (!result.success) {
    res.status(422).json(${issues});
    return;
  }
  req.body = ${assign};
  next();
};

// app.${input.method.toLowerCase()}("${pathOf(input.targetUrl)}", express.json(), ${guardName}, handler);
`,
    };
  }

  if (input.framework === "hono") {
    const subject = mode === "envelope" ? "{ headers: c.req.header(), body }" : "body";
    return {
      ok: true,
      mode,
      filename: `${base}-contract.hono.ts`,
      code: `${header}
import { createMiddleware } from "hono/factory";

${schema}

export const ${guardName} = createMiddleware(async (c, next) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const result = ${schemaName}.safeParse(${subject});
  if (!result.success) {
    return c.json(${issues}, 422);
  }
  await next();
});

// app.${input.method.toLowerCase()}("${pathOf(input.targetUrl)}", ${guardName}, handler);
`,
    };
  }

  const subject =
    mode === "envelope"
      ? "{ headers: Object.fromEntries(request.headers), body }"
      : "body";
  return {
    ok: true,
    mode,
    filename: `${base}-contract.ts`,
    code: `${header}

${schema}

/**
 * Framework-agnostic guard for Fetch-style handlers (Next.js route handlers,
 * Remix/React Router actions, Cloudflare Workers, Bun, Deno).
 * Returns a 4xx Response to send, or null when the request is valid.
 */
export async function ${guardName}(request: Request): Promise<Response | null> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const result = ${schemaName}.safeParse(${subject});
  if (!result.success) {
    return Response.json(${issues}, { status: 422 });
  }
  return null;
}

// export async function ${input.method.toUpperCase()}(request: Request) {
//   const rejected = await ${guardName}(request);
//   if (rejected) return rejected;
//   ...
// }
`,
  };
}

function pathOf(targetUrl: string): string {
  try {
    return new URL(targetUrl).pathname;
  } catch {
    return targetUrl.split("?")[0] ?? targetUrl;
  }
}
