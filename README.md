# ReqLab — Agent-Native API, Webhook & Chaos Testing Studio

**ReqLab** is an Agent-Native API, Webhook & Chaos Testing Studio built with [`@agent-native/core`](https://github.com/BuilderIO/agent-native) for the **Builder.io Agent-Native Hackathon**.

Most AI coding agents hand you a wall of `curl` commands or `pytest` snippets in chat and make you copy-paste payloads, inspect status codes, and figure out what broke on your own. **ReqLab** gives the agent and the engineer a **shared live workbench** (`/studio` and `/studio/:endpointId`):

1. **See the Agent's Work Live**: When the agent generates adversarial chaos scenarios (`boundary`, `schema-fuzz`, `injection`, `auth`, `idempotency`) or executes the Chaos Matrix, the rows land on the page as its actions complete, with HTTP status badges, latency checked against the endpoint's SLA budget, and the real exception behind every `500 Crash` (name, message, stack frames).
2. **Edit Anything Inline**: Click any scenario row in the Chaos Matrix to edit its request headers, JSON payload, or expected status in the Payload & Response Inspector (**Save & Re-Run** fires it immediately), or edit the endpoint's **Zod Contract Guard** in the guard panel.
3. **Tell the Agent What to Do Next**: Turn on **Select** mode in the agent composer (`useAgentSelectable`) and pick any endpoint card or scenario row to hand its exact context to the agent, or click **Ask Agent to Fix 500 Crashes** / **Ask Agent to Fix Failing Scenarios**. The agent diagnoses the real errors, writes a Zod contract guard (`update-endpoint`), and re-runs `run-scenarios`, flipping each `500` crash (`bug_exposed`) to a guarded `422` (`passed`) right on the page.

---

## Quick Start

```bash
git clone <your-repo-url> reqlab && cd reqlab
pnpm install
pnpm dev
pnpm test   # guard compiler + sandbox crash/fix suite
```

Open **`http://localhost:8080/studio`** in your browser.

### Optional CLI Smoke Test

With the dev server running (or standalone):

```bash
# 1. Seed 3 sandbox APIs with real bugs + 1 live HTTPS API (12 chaos scenarios)
AGENT_USER_EMAIL=dev@reqlab.dev pnpm action seed-demo-suite

# 2. List endpoints with live pass/bug/assertion counts
AGENT_USER_EMAIL=dev@reqlab.dev pnpm action list-endpoints

# 3. Run the Chaos Matrix on Checkout & Charge Ledger API (exposes 2 unhandled 500 crashes)
AGENT_NATIVE_NO_OPEN=1 AGENT_USER_EMAIL=dev@reqlab.dev pnpm action run-scenarios --endpointId <checkoutEndpointId>

# 4. Patch the endpoint's Zod Contract Guard and re-run (all 4 scenarios pass!)
AGENT_NATIVE_NO_OPEN=1 AGENT_USER_EMAIL=dev@reqlab.dev pnpm action update-endpoint \
  --id <checkoutEndpointId> \
  --contractZodSchema "z.object({ quantity: z.number().int().min(1), couponCode: z.string().optional() })"
AGENT_NATIVE_NO_OPEN=1 AGENT_USER_EMAIL=dev@reqlab.dev pnpm action run-scenarios --endpointId <checkoutEndpointId>
```

---

## Real Bugs, Real Guards, Real APIs

Nothing in ReqLab returns a canned 500. Every result comes from executing code or calling a real server.

### Sandbox APIs with real bugs (`server/lib/sandbox-apis.ts`)

Three small request handlers ship with genuine, unguarded bugs so anyone can see the full find → fix loop with zero setup. The crash you see in the Studio is the actual exception (name, message, and stack frames) thrown by the handler:

| Target Endpoint | Path | What actually crashes (unguarded) | Contract guard that fixes it |
| :--- | :--- | :--- | :--- |
| **Checkout & Charge Ledger API** | `POST /sandbox/checkout` | `quantity: -5` → Node `RangeError` from `Buffer.writeUInt32BE` in the ledger encoder<br>`couponCode: ["LAUNCH20","STACK99"]` → `TypeError: code.trim is not a function` | `z.object({ quantity: z.number().int().min(1), couponCode: z.string().optional() })` |
| **Stripe Invoice Webhook Receiver** | `POST /sandbox/webhooks/stripe` | Redelivering an already-processed event without a usable idempotency key → unhandled `UniqueViolationError` (23505) on the ledger insert | `z.object({ headers: z.object({ "x-idempotency-key": z.string().regex(/^idem_[A-Za-z0-9_]+$/) }) })` |
| **User Directory Search API** | `POST /sandbox/users/search` | `q: "alex' OR 1=1 --"` is interpolated into SQL → `SyntaxError: unterminated quoted string` from the query tokenizer (a balanced injection like `x' OR 'a'='a` instead leaks every row, which ReqLab flags as a contract mismatch) | `z.object({ q: z.string().max(64).regex(/^[a-zA-Z0-9 _@-]+$/) })` |

### Live HTTPS APIs

Any `https://` target is called over the network through the framework's `ssrfSafeFetch`: private, loopback, link-local, and cloud-metadata addresses are blocked (including after DNS resolution and on every redirect hop), requests time out after 8 s, responses are capped at 256 KB, and latency is measured end to end against the endpoint's SLA. The demo seed includes **JSONPlaceholder Posts API**: the baseline returns a real `201`, and the adversarial scenarios expose that the API accepts `userId: "1; DROP TABLE posts"` and empty titles. Applying a guard turns those into `422`s.

### Bug Hunt: the agent hunts crashes adaptively

On any endpoint, click **Bug Hunt**. The agent runs rounds of `attack-batch`: each round it fires a batch of adversarial requests, reads the real responses, and designs a sharper next batch aimed at whatever leaked a stack trace or accepted bad input — until it exposes a 5xx crash (or four rounds pass), then diagnoses the root cause, writes a guard, and offers to export it. Rows stream into the Chaos Matrix live as it works, so you watch the agent drive the UI instead of reading a wall of text.

### Import a whole API from its OpenAPI spec

Click **Import OpenAPI** and paste a spec URL (OpenAPI 3.x or Swagger 2.0, JSON or YAML). ReqLab (`import-openapi`) creates one endpoint per operation, each seeded with a baseline request built from the schema plus adversarial attacks derived from it (negative numbers, type confusion, injection, missing/null required fields, out-of-enum values, oversized strings). Point it at a public spec and run — e.g. the Swagger Petstore's live API returns a real unhandled **500** on an empty `PUT /pet` body, and wrongly accepts several malformed orders.

### Your own API on localhost

In development, point an endpoint at `http://localhost:3000/...` (any loopback port) to chaos-test the server you're building. Local calls skip DNS-based SSRF checks but never follow redirects; in production, loopback targets are always blocked.

### Credentials stay out of scenarios

Headers can reference stored credentials instead of embedding them: `{"authorization": "Bearer {{secret:REQLAB_TARGET_API_KEY}}"}`. Values live in **Settings → API keys** (`REQLAB_TARGET_API_KEY`, `REQLAB_TARGET_API_KEY_2`, `REQLAB_WEBHOOK_SIGNING_SECRET`), are resolved server-side only at run time, and are redacted from every stored response. Only these ReqLab keys can be referenced, so a header can't exfiltrate another app credential.

### Webhook inbox: capture real deliveries, replay them as scenarios

Each endpoint can get a public inbox URL (`/hooks/<token>`). Point Stripe (`stripe listen --forward-to <url>`), GitHub, Shopify, or your own service at it; captures appear live in the Studio (cookies and authorization headers are dropped, bodies capped at 256 KB, last 50 kept). **Save as Scenario** turns a real delivery into a replayable test, and the agent can do the same with `list-webhook-captures` → `create-scenario`.

### Ship the fix: export guards as middleware

A passing run means ReqLab's gateway blocked the bad input; your API still needs the check. **Export as Middleware** (or `export-contract-guard`) emits the exact guard as ready-to-paste **Express**, **Hono**, or framework-agnostic **Fetch** (Next.js, Workers, Bun, Deno) validation middleware that returns the same `422` with Zod issues.

### Zod contract guards (`server/lib/contract-guard.ts`)

A guard is real Zod source, e.g. `z.object({ quantity: z.number().int().min(1) })`. ReqLab compiles it with a small parser that only invokes allowlisted Zod factories and methods with data-only arguments, so guard text is never `eval`ed. Unsafe regexes (nested quantifiers) are rejected. Guards validate the JSON body, or `{ headers, body }` when written as an envelope. They run as a gateway in front of the target: requests that violate the contract get a `422` with the real Zod issues and never reach the API. `create-endpoint` and `update-endpoint` reject guards that don't compile (`invalid_contract`), so the agent gets precise feedback and can retry.

---

## Agent-Native Architecture

- **Shared Actions (`actions/*.ts`)**:
  - `list-endpoints`, `get-endpoint`, `create-endpoint`, `update-endpoint`, `delete-endpoint`
  - `create-scenario`, `update-scenario`, `delete-scenario`
  - `run-scenarios`, `seed-demo-suite`
  - `export-contract-guard`, `enable-webhook-inbox`, `list-webhook-captures`
  - `import-openapi`, `attack-batch`
  - `view-screen`, `navigate`
- **Database & Sharing (`server/db/schema.ts`, `server/db/index.ts`, `server/plugins/db.ts`)**:
  - `endpoints` (ownable via `ownableColumns()`) + `endpointShares` (`createSharesTable("endpoint_shares")`) registered via `registerShareableResource` (`type: "endpoint"`, `agentRead: { actions: ["get-endpoint"] }`)
  - `testScenarios` (enforces unique `(endpointId, title)` with `scenario_conflict` 409)
  - `scenarioRuns` (execution audit log with HTTP status, latency, verdict, and response preview)
  - `webhookCaptures` (real inbound deliveries from the public `/hooks/<token>` route in `server/routes/hooks/[token].ts`)
- **Domain Skill (`.agents/skills/api-chaos-testing/SKILL.md`)**:
  - Teaches the agent the 5-step adversarial chaos workflow (`view-screen` → `create-scenario` → `run-scenarios` → `update-endpoint` → `run-scenarios`).
