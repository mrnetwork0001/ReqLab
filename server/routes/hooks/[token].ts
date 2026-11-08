/**
 * Public webhook inbox: `ANY /hooks/<token>`.
 *
 * Point a real provider here (Stripe CLI `stripe listen --forward-to`, GitHub,
 * Shopify, your own service) and every request is captured on the endpoint so
 * it can be inspected and replayed as a chaos scenario. The unguessable token
 * is the only credential, so the route never reads cookies and only stores
 * request data. Cookies and authorization headers are dropped before storing.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, notInArray } from "drizzle-orm";
import { defineEventHandler, getRequestIP, getRouterParam } from "h3";

import { getDb, schema } from "../../db/index.js";

const MAX_STORED_BYTES = 256 * 1024;
const MAX_ACCEPTED_BYTES = 1024 * 1024;
const KEEP_CAPTURES = 50;
const DROPPED_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,80}$/;

async function readCapped(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), size: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let stored = 0;
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ACCEPTED_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    if (stored < MAX_STORED_BYTES) {
      const room = MAX_STORED_BYTES - stored;
      const part = value.byteLength > room ? value.subarray(0, room) : value;
      if (part !== value) truncated = true;
      chunks.push(part);
      stored += part.byteLength;
    } else {
      truncated = true;
    }
  }
  return { bytes: Buffer.concat(chunks), size, truncated };
}

export default defineEventHandler(async (event) => {
  const token = getRouterParam(event, "token") ?? "";
  if (!TOKEN_SHAPE.test(token)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const { endpoints, webhookCaptures } = schema;
  // The token is the capability: it is generated per endpoint and only shown
  // to people with access to that endpoint.
  const [endpoint] = await getDb()
    .select({ id: endpoints.id, ownerEmail: endpoints.ownerEmail, orgId: endpoints.orgId })
    .from(endpoints)
    .where(eq(endpoints.inboxToken, token))
    .limit(1);
  if (!endpoint) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const request = event.req as Request;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_ACCEPTED_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const body = await readCapped(request);
  if (!body) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!DROPPED_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  });

  const id = randomUUID();
  await getDb()
    .insert(webhookCaptures)
    .values({
      id,
      endpointId: endpoint.id,
      method: request.method.toUpperCase(),
      headersJson: JSON.stringify(headers),
      bodyText: Buffer.from(body.bytes).toString("utf8"),
      contentType: request.headers.get("content-type") ?? "",
      sizeBytes: body.size,
      truncated: body.truncated ? 1 : 0,
      sourceIp: getRequestIP(event, { xForwardedFor: true }) ?? "",
      ownerEmail: endpoint.ownerEmail,
      orgId: endpoint.orgId,
      receivedAt: new Date().toISOString(),
    });

  // Keep only the most recent captures per endpoint.
  const keep = await getDb()
    .select({ id: webhookCaptures.id })
    .from(webhookCaptures)
    .where(eq(webhookCaptures.endpointId, endpoint.id))
    .orderBy(desc(webhookCaptures.receivedAt))
    .limit(KEEP_CAPTURES);
  if (keep.length >= KEEP_CAPTURES) {
    await getDb()
      .delete(webhookCaptures)
      .where(
        and(
          eq(webhookCaptures.endpointId, endpoint.id),
          notInArray(
            webhookCaptures.id,
            keep.map((row) => row.id),
          ),
        ),
      );
  }

  return Response.json({ received: true, captureId: id }, { status: 200 });
});
