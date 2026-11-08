import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import { accessFilter } from "@agent-native/core/sharing";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const errors = defineActionErrors("unauthorized");

export default defineAction({
  description:
    "Seed ReqLab with 3 sandbox APIs that contain real bugs (Checkout Ledger API, Stripe Webhook Receiver, User Directory Search) plus 1 live HTTPS API (JSONPlaceholder), with 12 baseline/adversarial chaos scenarios. Skips endpoints whose URL already exists.",
  schema: z.object({}),
  outputSchema: z.object({
    seededCount: z.number(),
    endpointIds: z.array(z.string()),
    firstEndpointId: z.string(),
  }),
  errors,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  link: ({ result }) => ({
    url: buildDeepLink({
      view: "studio",
      to: `/studio/${encodeURIComponent(result.firstEndpointId)}`,
      params: { endpointId: result.firstEndpointId },
    }),
    label: "Open Seeded Sandbox in Studio",
  }),
  run: async (_args, ctx) => {
    const ownerEmail = ctx?.userEmail;
    if (!ownerEmail) {
      return errors.noWrite("Sign in to seed demo endpoints.", "unauthorized", {
        statusCode: 401,
      });
    }
    const orgId = ctx?.orgId ?? null;
    const visibility = orgId ? ("org" as const) : ("private" as const);
    const { endpoints, endpointShares, testScenarios } = schema;

    const existing = await getDb()
      .select({ id: endpoints.id, targetUrl: endpoints.targetUrl })
      .from(endpoints)
      .where(accessFilter(endpoints, endpointShares))
      .limit(50);

    const existingUrls = new Set(existing.map((e) => e.targetUrl));
    const now = new Date().toISOString();
    const createdIds: string[] = [];

    const specs = [
      {
        name: "Checkout & Charge Ledger API",
        method: "POST",
        targetUrl: "/sandbox/checkout",
        headersJson: JSON.stringify(
          { Authorization: "Bearer live_tok_98a1", "Content-Type": "application/json" },
          null,
          2,
        ),
        sampleBodyJson: JSON.stringify(
          {
            sku: "pro-seat-annual",
            quantity: 2,
            unitPriceCents: 4900,
            currency: "USD",
            couponCode: "LAUNCH20",
          },
          null,
          2,
        ),
        expectedStatus: 200,
        maxLatencyMs: 500,
        notes:
          "Processes customer seat upgrades and coupon discounts. Known suspicion: negative quantities and non-string coupon codes.",
        scenarios: [
          {
            title: "Baseline Valid Pro Checkout",
            category: "baseline",
            headersJson: "{}",
            bodyJson: JSON.stringify(
              {
                sku: "pro-seat-annual",
                quantity: 2,
                unitPriceCents: 4900,
                currency: "USD",
                couponCode: "LAUNCH20",
              },
              null,
              2,
            ),
            expectedStatus: 200,
          },
          {
            title: "Negative Quantity Refund Underflow (-5)",
            category: "boundary",
            headersJson: "{}",
            bodyJson: JSON.stringify(
              {
                sku: "pro-seat-annual",
                quantity: -5,
                unitPriceCents: 4900,
                currency: "USD",
              },
              null,
              2,
            ),
            expectedStatus: 422,
          },
          {
            title: "Coupon Code Array Type Confusion",
            category: "schema-fuzz",
            headersJson: "{}",
            bodyJson: JSON.stringify(
              {
                sku: "pro-seat-annual",
                quantity: 1,
                unitPriceCents: 4900,
                couponCode: ["LAUNCH20", "STACK99"],
              },
              null,
              2,
            ),
            expectedStatus: 422,
          },
          {
            title: "Expired Bearer Token Rejection",
            category: "auth",
            headersJson: JSON.stringify(
              { Authorization: "Bearer expired_token" },
              null,
              2,
            ),
            bodyJson: JSON.stringify(
              { sku: "pro-seat-annual", quantity: 1, unitPriceCents: 4900 },
              null,
              2,
            ),
            expectedStatus: 401,
          },
        ],
      },
      {
        name: "Stripe Invoice Webhook Receiver",
        method: "POST",
        targetUrl: "/sandbox/webhooks/stripe",
        headersJson: JSON.stringify(
          {
            "stripe-signature": "t=1730990000,v1=valid_hmac_sig",
            "x-idempotency-key": "idem_live_001",
          },
          null,
          2,
        ),
        sampleBodyJson: JSON.stringify(
          {
            eventId: "evt_live_200",
            type: "invoice.paid",
            amountPaidCents: 9800,
          },
          null,
          2,
        ),
        expectedStatus: 200,
        maxLatencyMs: 400,
        notes:
          "Synchronizes Stripe invoice.paid webhooks into subscription ledger.",
        scenarios: [
          {
            title: "Valid Signed invoice.paid Event",
            category: "baseline",
            headersJson: "{}",
            bodyJson: JSON.stringify(
              {
                eventId: "evt_live_200",
                type: "invoice.paid",
                amountPaidCents: 9800,
              },
              null,
              2,
            ),
            expectedStatus: 200,
          },
          {
            title: "Duplicate Event Replay Without Idempotency Guard",
            category: "idempotency",
            headersJson: JSON.stringify(
              { "x-idempotency-key": "missing" },
              null,
              2,
            ),
            bodyJson: JSON.stringify(
              {
                eventId: "evt_duplicate_99",
                type: "invoice.paid",
                replayDuplicate: true,
              },
              null,
              2,
            ),
            expectedStatus: 422,
          },
          {
            title: "Tampered HMAC Signature Header",
            category: "auth",
            headersJson: JSON.stringify(
              { "stripe-signature": "t=1730990000,v1=tampered_hash" },
              null,
              2,
            ),
            bodyJson: JSON.stringify(
              { eventId: "evt_live_201", type: "invoice.paid" },
              null,
              2,
            ),
            expectedStatus: 400,
          },
        ],
      },
      {
        name: "User Directory Search API",
        method: "POST",
        targetUrl: "/sandbox/users/search",
        headersJson: JSON.stringify(
          { "Content-Type": "application/json" },
          null,
          2,
        ),
        sampleBodyJson: JSON.stringify({ q: "alex", limit: 20 }, null, 2),
        expectedStatus: 200,
        maxLatencyMs: 350,
        notes: "Searches workspace users by email or handle.",
        scenarios: [
          {
            title: "Standard Handle Lookup",
            category: "baseline",
            headersJson: "{}",
            bodyJson: JSON.stringify({ q: "alex", limit: 20 }, null, 2),
            expectedStatus: 200,
          },
          {
            title: "SQL Boolean Injection Payload (' OR 1=1 --)",
            category: "injection",
            headersJson: "{}",
            bodyJson: JSON.stringify(
              { q: "alex' OR 1=1 --", limit: 20 },
              null,
              2,
            ),
            expectedStatus: 422,
          },
        ],
      },
      {
        name: "JSONPlaceholder Posts API (live HTTPS)",
        method: "POST",
        targetUrl: "https://jsonplaceholder.typicode.com/posts",
        headersJson: JSON.stringify(
          { "Content-Type": "application/json; charset=UTF-8" },
          null,
          2,
        ),
        sampleBodyJson: JSON.stringify(
          { title: "ReqLab launch notes", body: "Chaos matrix run", userId: 1 },
          null,
          2,
        ),
        expectedStatus: 201,
        maxLatencyMs: 1500,
        notes:
          "A real public API called over the network (SSRF-protected). It accepts any payload, so adversarial scenarios expose missing input validation until a contract guard is applied.",
        scenarios: [
          {
            title: "Baseline Create Post",
            category: "baseline",
            headersJson: "{}",
            bodyJson: JSON.stringify(
              { title: "ReqLab launch notes", body: "Chaos matrix run", userId: 1 },
              null,
              2,
            ),
            expectedStatus: 201,
          },
          {
            title: "userId Type Confusion (SQL-ish string)",
            category: "schema-fuzz",
            headersJson: "{}",
            bodyJson: JSON.stringify(
              { title: "x", body: "y", userId: "1; DROP TABLE posts" },
              null,
              2,
            ),
            expectedStatus: 422,
          },
          {
            title: "Empty Title and Zero userId",
            category: "boundary",
            headersJson: "{}",
            bodyJson: JSON.stringify({ title: "", body: "", userId: 0 }, null, 2),
            expectedStatus: 422,
          },
        ],
      },
    ];

    for (const spec of specs) {
      if (existingUrls.has(spec.targetUrl)) continue;
      const endpointId = crypto.randomUUID();
      await getDb().insert(endpoints).values({
        id: endpointId,
        name: spec.name,
        method: spec.method,
        targetUrl: spec.targetUrl,
        headersJson: spec.headersJson,
        sampleBodyJson: spec.sampleBodyJson,
        expectedStatus: spec.expectedStatus,
        maxLatencyMs: spec.maxLatencyMs,
        contractZodSchema: "",
        notes: spec.notes,
        lastRevisedBy: "human",
        revisionCount: 1,
        createdAt: now,
        updatedAt: now,
        ownerEmail,
        orgId,
        visibility,
      });

      for (const sc of spec.scenarios) {
        await getDb().insert(testScenarios).values({
          id: crypto.randomUUID(),
          endpointId,
          title: sc.title,
          category: sc.category,
          headersJson: sc.headersJson,
          bodyJson: sc.bodyJson,
          expectedStatus: sc.expectedStatus,
          lastVerdict: "untested",
          authoredBy: "agent",
          ownerEmail,
          orgId,
          createdAt: now,
        });
      }
      createdIds.push(endpointId);
    }

    const allIds = [...createdIds, ...existing.map((e) => e.id)];
    return {
      seededCount: createdIds.length,
      endpointIds: allIds,
      firstEndpointId: allIds[0] ?? "",
    };
  },
});
