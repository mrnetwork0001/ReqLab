import { describe, expect, it } from "vitest";

import { parseOpenApi, parseSpecText } from "./openapi-import";

const SPEC = {
  openapi: "3.0.0",
  info: { title: "Orders API" },
  servers: [{ url: "https://api.example.com/v1" }],
  components: {
    schemas: {
      Order: {
        type: "object",
        required: ["sku", "quantity"],
        properties: {
          sku: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
          coupon: { type: "string" },
          status: { type: "string", enum: ["new", "paid"] },
        },
      },
    },
  },
  paths: {
    "/orders": {
      post: {
        summary: "Create order",
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
        },
        responses: { "201": {} },
      },
    },
    "/orders/{id}": {
      get: { summary: "Get order", responses: { "200": {} } },
    },
  },
};

describe("openapi import", () => {
  it("parses JSON and YAML", () => {
    expect(parseSpecText(JSON.stringify(SPEC))).toBeTruthy();
    expect(parseSpecText("openapi: 3.0.0\ninfo:\n  title: X\npaths: {}")).toMatchObject({
      openapi: "3.0.0",
    });
    expect(parseSpecText("<<< not valid >>>\n\tbad: [")).toBeNull();
  });

  it("creates one operation per method with resolved base URL and sample body", () => {
    const result = parseOpenApi(SPEC, "https://api.example.com/v1/openapi.json");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe("Orders API");
    expect(result.baseUrl).toBe("https://api.example.com/v1");

    const post = result.operations.find((o) => o.method === "POST");
    expect(post?.targetUrl).toBe("https://api.example.com/v1/orders");
    expect(post?.expectedStatus).toBe(201);
    const sample = JSON.parse(post!.sampleBodyJson);
    expect(sample).toMatchObject({ sku: "sample", quantity: 1, status: "new" });

    // GET with no body gets no derived attacks; POST gets several.
    const get = result.operations.find((o) => o.method === "GET");
    expect(get?.attacks).toHaveLength(0);
    expect(post!.attacks.length).toBeGreaterThanOrEqual(5);
  });

  it("derives attacks that should be rejected, covering type confusion and injection", () => {
    const result = parseOpenApi(SPEC, "https://api.example.com/v1/openapi.json");
    if (!result.ok) throw new Error(result.error);
    const post = result.operations.find((o) => o.method === "POST")!;
    const titles = post.attacks.map((a) => a.title);
    expect(titles.some((t) => /Negative "quantity"/.test(t))).toBe(true);
    expect(titles.some((t) => /Injection in "sku"/.test(t))).toBe(true);
    expect(post.attacks.every((a) => a.expectedStatus >= 400 && a.expectedStatus < 500)).toBe(true);
    // Every attack body is valid JSON.
    for (const attack of post.attacks) expect(() => JSON.parse(attack.bodyJson)).not.toThrow();
  });

  it("rejects a document with no paths", () => {
    expect(parseOpenApi({ info: { title: "x" } }, "https://x").ok).toBe(false);
  });

  it("handles Swagger 2.0 host + basePath", () => {
    const swagger = {
      swagger: "2.0",
      info: { title: "Legacy" },
      host: "legacy.example.com",
      basePath: "/api",
      paths: { "/ping": { get: { responses: { "200": {} } } } },
    };
    const result = parseOpenApi(swagger, "https://legacy.example.com/swagger.json");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.operations[0]!.targetUrl).toBe("https://legacy.example.com/api/ping");
  });
});
