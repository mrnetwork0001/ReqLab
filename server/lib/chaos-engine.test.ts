import { describe, expect, it } from "vitest";

import { compileContractGuard, evaluateContractGuard } from "./contract-guard";
import {
  type EndpointTarget,
  executeScenarioAgainstEndpoint,
  type ScenarioInput,
} from "./runner";

function guardOf(text: string) {
  const compiled = compileContractGuard(text);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.guard;
}

function endpoint(targetUrl: string, overrides: Partial<EndpointTarget> = {}): EndpointTarget {
  return {
    id: "ep",
    name: "test",
    method: "POST",
    targetUrl,
    headersJson: "{}",
    expectedStatus: 200,
    maxLatencyMs: 5_000,
    contractZodSchema: "",
    ...overrides,
  };
}

function scenario(body: unknown, expectedStatus: number, headers: Record<string, string> = {}): ScenarioInput {
  return {
    id: "sc",
    title: "scenario",
    category: "boundary",
    headersJson: JSON.stringify(headers),
    bodyJson: JSON.stringify(body),
    expectedStatus,
  };
}

describe("contract guard compiler", () => {
  it("compiles real Zod and reports real issues", () => {
    const guard = guardOf("z.object({ quantity: z.number().int().min(1), couponCode: z.string().optional() })");
    expect(evaluateContractGuard(guard!, { body: { quantity: 2 }, headers: {} })).toEqual({ ok: true });
    const bad = evaluateContractGuard(guard!, { body: { quantity: -5, couponCode: ["A"] }, headers: {} });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.map((i) => i.path.join("."))).toEqual(["quantity", "couponCode"]);
    }
  });

  it("supports regex literals, enums, defaults, unions and envelope mode", () => {
    const guard = guardOf(`z.object({
      headers: z.object({ "x-idempotency-key": z.string().regex(/^idem_[A-Za-z0-9_]+$/) }),
      body: z.object({ kind: z.enum(["a", "b"]).default("a"), id: z.union([z.string(), z.number()]) }),
    })`);
    expect(guard!.mode).toBe("envelope");
    expect(evaluateContractGuard(guard!, { headers: { "x-idempotency-key": "idem_1" }, body: { id: 1 } }).ok).toBe(true);
    expect(evaluateContractGuard(guard!, { headers: { "x-idempotency-key": "missing" }, body: { id: 1 } }).ok).toBe(false);
  });

  it("treats empty text as no guard", () => {
    expect(compileContractGuard("   ")).toEqual({ ok: true, guard: null });
  });

  it.each([
    ["arbitrary code", 'process.exit(1)'],
    ["constructor escape", 'z.string().constructor("return process")()'],
    ["refine callbacks", "z.string().refine(() => true)"],
    ["template interpolation", "z.literal(`${globalThis.secret}`)"],
    ["prototype keys", "z.object({ __proto__: z.string() })"],
    ["catastrophic regex", "z.string().regex(/^(a+)+$/)"],
    ["global regex flag", "z.string().regex(/a/g)"],
    ["unknown factory", "z.custom()"],
    ["trailing garbage", "z.string(); fetch('https://evil.example')"],
  ])("rejects %s", (_label, text) => {
    const compiled = compileContractGuard(text);
    expect(compiled.ok).toBe(false);
  });
});

describe("sandbox APIs crash for real, and the guard fixes them", () => {
  const auth = { Authorization: "Bearer live_tok_98a1" };
  const checkoutGuard = "z.object({ quantity: z.number().int().min(1), couponCode: z.string().optional() })";

  it("checkout: negative quantity throws a real RangeError from the ledger encoder", async () => {
    const res = await executeScenarioAgainstEndpoint(
      endpoint("/sandbox/checkout"),
      scenario({ quantity: -5, unitPriceCents: 4900 }, 422, auth),
      null,
    );
    expect(res.httpCode).toBe(500);
    expect(res.verdict).toBe("bug_exposed");
    expect(res.bugSummary).toContain("RangeError");
    expect(res.responseJson).toContain("out of range");
  });

  it("checkout: array couponCode throws a real TypeError", async () => {
    const res = await executeScenarioAgainstEndpoint(
      endpoint("/sandbox/checkout"),
      scenario({ quantity: 1, couponCode: ["LAUNCH20", "STACK99"] }, 422, auth),
      null,
    );
    expect(res.httpCode).toBe(500);
    expect(res.bugSummary).toContain("trim is not a function");
  });

  it("checkout: the contract guard turns both crashes into 422 and keeps the happy path", async () => {
    const guard = guardOf(checkoutGuard);
    const ep = endpoint("/sandbox/checkout");
    const neg = await executeScenarioAgainstEndpoint(ep, scenario({ quantity: -5 }, 422, auth), guard);
    const arr = await executeScenarioAgainstEndpoint(ep, scenario({ quantity: 1, couponCode: ["A"] }, 422, auth), guard);
    const ok = await executeScenarioAgainstEndpoint(ep, scenario({ quantity: 2, couponCode: "launch20" }, 200, auth), guard);
    expect([neg.httpCode, arr.httpCode, ok.httpCode]).toEqual([422, 422, 200]);
    expect([neg.verdict, arr.verdict, ok.verdict]).toEqual(["passed", "passed", "passed"]);
    expect(JSON.parse(ok.responseJson).discountPct).toBe(20);
  });

  it("checkout: expired token is a 401, not a crash", async () => {
    const res = await executeScenarioAgainstEndpoint(
      endpoint("/sandbox/checkout"),
      scenario({ quantity: 1 }, 401, { Authorization: "Bearer expired_token" }),
      null,
    );
    expect(res.httpCode).toBe(401);
    expect(res.verdict).toBe("passed");
  });

  it("webhook: replaying a processed event crashes on the unique constraint until headers are guarded", async () => {
    const ep = endpoint("/sandbox/webhooks/stripe", {
      headersJson: JSON.stringify({ "stripe-signature": "t=1,v1=valid_hmac_sig", "x-idempotency-key": "idem_live_001" }),
    });
    const replay = scenario({ eventId: "evt_duplicate_99", type: "invoice.paid" }, 422, { "x-idempotency-key": "missing" });
    const crashed = await executeScenarioAgainstEndpoint(ep, replay, null);
    expect(crashed.httpCode).toBe(500);
    expect(crashed.bugSummary).toContain("UniqueViolationError");

    const guard = guardOf('z.object({ headers: z.object({ "x-idempotency-key": z.string().regex(/^idem_[A-Za-z0-9_]+$/) }) })');
    expect((await executeScenarioAgainstEndpoint(ep, replay, guard)).httpCode).toBe(422);
    const baseline = scenario({ eventId: "evt_live_200", type: "invoice.paid" }, 200);
    expect((await executeScenarioAgainstEndpoint(ep, baseline, guard)).httpCode).toBe(200);
    const tampered = scenario({ eventId: "evt_live_201" }, 400, { "stripe-signature": "t=1,v1=tampered_hash" });
    expect((await executeScenarioAgainstEndpoint(ep, tampered, guard)).httpCode).toBe(400);
  });

  it("users search: SQL injection breaks the real tokenizer until the query is guarded", async () => {
    const ep = endpoint("/sandbox/users/search");
    const injection = scenario({ q: "alex' OR 1=1 --", limit: 20 }, 422);
    const crashed = await executeScenarioAgainstEndpoint(ep, injection, null);
    expect(crashed.httpCode).toBe(500);
    expect(crashed.bugSummary).toContain("unterminated quoted string");

    const guard = guardOf("z.object({ q: z.string().max(64).regex(/^[a-zA-Z0-9 _@-]+$/) })");
    expect((await executeScenarioAgainstEndpoint(ep, injection, guard)).httpCode).toBe(422);
    const lookup = await executeScenarioAgainstEndpoint(ep, scenario({ q: "alex", limit: 20 }, 200), guard);
    expect(JSON.parse(lookup.responseJson).users).toHaveLength(1);
  });

  it("users search: a balanced injection leaks every row (caught as a contract mismatch)", async () => {
    const res = await executeScenarioAgainstEndpoint(
      endpoint("/sandbox/users/search"),
      scenario({ q: "x' OR 'a'='a", limit: 20 }, 422),
      null,
    );
    expect(res.httpCode).toBe(200);
    expect(res.verdict).toBe("assertion_failed");
    expect(JSON.parse(res.responseJson).total).toBe(3);
  });

  it("external URLs: private addresses are blocked by the SSRF guard", async () => {
    const res = await executeScenarioAgainstEndpoint(
      endpoint("http://169.254.169.254/latest/meta-data"),
      scenario({}, 200),
      null,
    );
    expect(res.httpCode).toBe(0);
    expect(res.bugSummary).toContain("SSRF blocked");
  });

  it("external URLs: the guard rejects bad input before any network call", async () => {
    const res = await executeScenarioAgainstEndpoint(
      endpoint("https://jsonplaceholder.typicode.com/posts", { expectedStatus: 201 }),
      scenario({ title: "", userId: "1; DROP TABLE posts" }, 422),
      guardOf("z.object({ title: z.string().min(1), userId: z.number().int().positive() })"),
    );
    expect(res.httpCode).toBe(422);
    expect(res.responseJson).toContain("request never reached");
  });
});

describe("local targets, secrets, and guard export", () => {
  it("calls a real local HTTP server in development and redacts resolved secrets", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { quantity?: unknown };
        if (typeof body.quantity !== "number") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "TypeError: quantity.toFixed is not a function" }));
          return;
        }
        res.writeHead(201, { "content-type": "application/json" });
        // Echoes the auth header back, like many debug endpoints do.
        res.end(JSON.stringify({ ok: true, echoedAuth: req.headers.authorization }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const ep = endpoint(`http://127.0.0.1:${port}/orders`, {
        expectedStatus: 201,
        headersJson: JSON.stringify({ authorization: "Bearer {{secret:REQLAB_TARGET_API_KEY}}" }),
      });
      const secrets = { REQLAB_TARGET_API_KEY: "sk_live_super_secret_123" };
      const ok = await executeScenarioAgainstEndpoint(ep, scenario({ quantity: 2 }, 201), null, { secrets });
      expect(ok.httpCode).toBe(201);
      expect(ok.verdict).toBe("passed");
      expect(ok.responseJson).not.toContain("sk_live_super_secret_123");
      expect(ok.responseJson).toContain("[redacted:REQLAB_TARGET_API_KEY]");

      const crash = await executeScenarioAgainstEndpoint(ep, scenario({ quantity: "2" }, 422), null, { secrets });
      expect(crash.httpCode).toBe(500);
      expect(crash.verdict).toBe("bug_exposed");
    } finally {
      server.close();
    }
  });

  it("finds only allowlisted secret references", async () => {
    const { findSecretReferences, isTargetSecretKey } = await import("./target-secrets");
    const refs = findSecretReferences('{"a":"{{secret:REQLAB_TARGET_API_KEY}}","b":"{{ secret:ANTHROPIC_API_KEY }}"}');
    expect(refs).toEqual(["REQLAB_TARGET_API_KEY", "ANTHROPIC_API_KEY"]);
    expect(refs.filter((k) => !isTargetSecretKey(k))).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("exports a guard as Express, Hono, and Fetch middleware", async () => {
    const { exportContractGuard } = await import("./guard-export");
    const guardText = "z.object({ quantity: z.number().int().min(1) })";
    for (const framework of ["express", "hono", "fetch"] as const) {
      const out = exportContractGuard({
        endpointName: "Checkout & Charge Ledger API",
        method: "POST",
        targetUrl: "/sandbox/checkout",
        guardText,
        framework,
      });
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.code).toContain('import { z } from "zod"');
        expect(out.code).toContain("checkoutChargeLedgerApiContract = z.object({ quantity: z.number().int().min(1) })");
        expect(out.code).toContain("422");
      }
    }
    const envelope = exportContractGuard({
      endpointName: "Stripe Webhook",
      method: "POST",
      targetUrl: "/sandbox/webhooks/stripe",
      guardText: 'z.object({ headers: z.object({ "x-idempotency-key": z.string() }) })',
      framework: "express",
    });
    expect(envelope.ok && envelope.code).toContain("{ headers: req.headers, body: req.body }");
    expect(exportContractGuard({ endpointName: "x", method: "POST", targetUrl: "/x", guardText: "", framework: "hono" }).ok).toBe(false);
  });
});
