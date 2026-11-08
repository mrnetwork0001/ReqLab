/**
 * Built-in sandbox target APIs.
 *
 * These are small but real request handlers with real, unguarded bugs. Nothing
 * here returns a canned 500: every crash is an actual exception thrown by the
 * handler code below (a Node RangeError, a TypeError, a SQL tokenizer failure,
 * a unique-constraint violation). The runner catches uncaught exceptions the
 * way an HTTP framework would and turns them into a 500 response.
 *
 * Each request gets fresh in-memory state, so results are deterministic.
 */
import { timingSafeEqual } from "node:crypto";

export interface SandboxRequest {
  method: string;
  path: string;
  /** Lowercased header names. */
  headers: Record<string, string>;
  body: unknown;
}

export interface SandboxResponse {
  status: number;
  body: unknown;
}

type Handler = (req: SandboxRequest) => SandboxResponse;

// ---------------------------------------------------------------------------
// 1. POST /sandbox/checkout — Checkout & Charge Ledger API
// ---------------------------------------------------------------------------

const COUPONS: Record<string, number> = { LAUNCH20: 20, TEAM10: 10 };
const EXPIRED_TOKENS = new Set(["expired_token"]);

function normalizeCoupon(code: string): string {
  // Bug: assumes couponCode is always a string.
  return code.trim().toUpperCase();
}

function encodeLedgerDebit(totalCents: number): string {
  // The ledger stores debits as unsigned 32-bit integers. Negative totals are
  // never expected, so nothing checks for them before encoding.
  const record = Buffer.alloc(4);
  record.writeUInt32BE(totalCents);
  return record.toString("hex");
}

const checkout: Handler = (req) => {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!token || EXPIRED_TOKENS.has(token)) {
    return {
      status: 401,
      body: { error: "unauthorized", message: "Bearer token is missing or expired." },
    };
  }

  const {
    sku = "pro-seat-annual",
    quantity = 1,
    unitPriceCents = 4900,
    currency = "USD",
    couponCode,
  } = req.body as {
    sku?: string;
    quantity?: number;
    unitPriceCents?: number;
    currency?: string;
    couponCode?: string;
  };

  const discountPct =
    couponCode === undefined ? 0 : (COUPONS[normalizeCoupon(couponCode)] ?? 0);
  const subtotalCents = quantity * unitPriceCents;
  const totalCents = Math.round((subtotalCents * (100 - discountPct)) / 100);
  const ledgerRef = encodeLedgerDebit(totalCents);

  return {
    status: 200,
    body: {
      orderId: `ord_${ledgerRef}`,
      status: "captured",
      sku,
      quantity,
      subtotalCents,
      discountPct,
      totalCents,
      currency,
    },
  };
};

// ---------------------------------------------------------------------------
// 2. POST /sandbox/webhooks/stripe — Stripe Invoice Webhook Receiver
// ---------------------------------------------------------------------------

/** Test-mode signing secret for the sandbox: the expected v1 signature. */
const SANDBOX_SIGNATURE = "valid_hmac_sig";

class UniqueViolationError extends Error {
  code = "23505";
  constructor(constraint: string, key: string) {
    super(`duplicate key value violates unique constraint "${constraint}" (event_id)=(${key})`);
    this.name = "UniqueViolationError";
  }
}

function createLedger(alreadyProcessed: string[]) {
  const events = new Set(alreadyProcessed);
  return {
    insertEvent(eventId: string) {
      if (events.has(eventId)) {
        throw new UniqueViolationError("ledger_events_event_id_key", eventId);
      }
      events.add(eventId);
    },
  };
}

function verifySignature(header: string): boolean {
  const v1 = /(?:^|,)v1=([^,]+)/.exec(header)?.[1] ?? "";
  const a = Buffer.from(v1);
  const b = Buffer.from(SANDBOX_SIGNATURE);
  return a.length === b.length && timingSafeEqual(a, b);
}

const stripeWebhook: Handler = (req) => {
  if (!verifySignature(req.headers["stripe-signature"] ?? "")) {
    return {
      status: 400,
      body: { error: "invalid_signature", message: "Webhook HMAC signature verification failed." },
    };
  }

  const event = req.body as { eventId: string; type?: string; amountPaidCents?: number };
  // Fresh per-request state: evt_duplicate_99 was delivered (and processed) earlier.
  const ledger = createLedger(["evt_duplicate_99"]);
  const processedKeys = new Set(["idem_evt_duplicate_99"]);

  const idempotencyKey = req.headers["x-idempotency-key"] ?? "";
  if (processedKeys.has(idempotencyKey)) {
    return { status: 200, body: { received: true, duplicate: true, eventId: event.eventId } };
  }

  // Bug: without a usable idempotency key, a redelivered event goes straight to
  // the ledger insert and the unique constraint violation is never handled.
  ledger.insertEvent(event.eventId);

  return {
    status: 200,
    body: { received: true, eventId: event.eventId, type: event.type ?? "invoice.paid" },
  };
};

// ---------------------------------------------------------------------------
// 3. POST /sandbox/users/search — User Directory Search API
// ---------------------------------------------------------------------------

const USERS = [
  { id: "usr_01", handle: "alex", email: "alex@acme.dev", role: "admin" },
  { id: "usr_02", handle: "sam", email: "sam@acme.dev", role: "builder" },
  { id: "usr_03", handle: "riley", email: "riley@acme.dev", role: "viewer" },
];

type SqlToken = { kind: "word" | "string" | "number" | "symbol"; text: string };

/** A deliberately minimal SQL tokenizer (no comment support), like many hand-rolled query layers. */
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (c === "'") {
      const end = sql.indexOf("'", i + 1);
      if (end === -1) {
        throw new SyntaxError(`unterminated quoted string at or near "${sql.slice(i, i + 24)}"`);
      }
      tokens.push({ kind: "string", text: sql.slice(i + 1, end) });
      i = end + 1;
    } else if (/\d/.test(c)) {
      const match = /^\d+/.exec(sql.slice(i))![0];
      tokens.push({ kind: "number", text: match });
      i += match.length;
    } else if (/[A-Za-z_]/.test(c)) {
      const match = /^[A-Za-z_]\w*/.exec(sql.slice(i))![0];
      tokens.push({ kind: "word", text: match.toUpperCase() });
      i += match.length;
    } else {
      tokens.push({ kind: "symbol", text: c });
      i++;
    }
  }
  return tokens;
}

const usersSearch: Handler = (req) => {
  const { q = "", limit = 20 } = (req.body ?? {}) as { q?: string; limit?: number };
  // Bug: the search term is interpolated straight into SQL.
  const sql = `SELECT id, email, role FROM users WHERE handle ILIKE '${q}%' LIMIT ${Number(limit)}`;
  const tokens = tokenizeSql(sql);

  const prefix = tokens.find((t) => t.kind === "string")?.text.replace(/%$/, "") ?? "";
  // If the injected text produced a boolean OR outside a string, every row matches.
  const injectedOr = tokens.some((t) => t.kind === "word" && t.text === "OR");
  const users = USERS.filter(
    (u) => injectedOr || u.handle.toLowerCase().startsWith(prefix.toLowerCase()),
  ).slice(0, Math.max(0, Number(limit) || 0));

  return { status: 200, body: { users, total: users.length } };
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES: Array<{ path: string; methods: string[]; handler: Handler }> = [
  { path: "/sandbox/checkout", methods: ["POST"], handler: checkout },
  { path: "/sandbox/webhooks/stripe", methods: ["POST"], handler: stripeWebhook },
  { path: "/sandbox/users/search", methods: ["GET", "POST"], handler: usersSearch },
];

export const SANDBOX_PATHS = ROUTES.map((r) => r.path);

/** Routes a sandbox request. Throws whatever the handler throws (the caller maps it to a 500). */
export function handleSandboxRequest(req: SandboxRequest): SandboxResponse {
  const path = (req.path.split("?")[0] ?? "").replace(/\/+$/, "");
  const route = ROUTES.find((r) => r.path === path);
  if (!route) {
    return {
      status: 404,
      body: { error: "not_found", message: `No sandbox API at ${path}.`, available: SANDBOX_PATHS },
    };
  }
  if (!route.methods.includes(req.method)) {
    return {
      status: 405,
      body: { error: "method_not_allowed", allowed: route.methods },
    };
  }
  return route.handler(req);
}
