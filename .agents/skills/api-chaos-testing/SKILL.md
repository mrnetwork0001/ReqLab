---
name: api-chaos-testing
description: >-
  Workflow for stress-testing API and webhook endpoints in ReqLab, uncovering
  500 crashes with adversarial chaos scenarios, and applying Zod contract
  guards to remediate vulnerabilities.
scope: both
---

# API Chaos Testing & Contract Remediation Playbook

## 1. Inspect Context First
Read `<current-screen>` (or call `view-screen` if fresh visible details are needed) to check `navigation.endpointId` and `navigation.scenarioId`. If no endpoints exist yet, call `seed-demo-suite` to populate 3 sandbox APIs with real bugs and 1 live HTTPS API.

## 2. Generate & Run Adversarial Chaos Scenarios
When asked to fuzz or stress-test an endpoint:
1. Call `get-endpoint` to inspect the baseline `sampleBodyJson`, `headersJson`, and existing `scenarios`.
2. Add targeted adversarial scenarios with `create-scenario` across categories:
   - `boundary`: negative numbers (`quantity: -5`), zero values, huge integers.
   - `schema-fuzz`: array instead of string (`couponCode: ["A", "B"]`), null fields.
   - `idempotency`: duplicate `eventId` with `replayDuplicate: true` or missing `x-idempotency-key`.
   - `injection`: SQL boolean payloads (`' OR 1=1 --`) or oversized strings.
   - `auth`: expired or tampered bearer/signature headers (`expectedStatus: 401` or `400`).
3. Call `run-scenarios` with `endpointId` to execute the matrix and record verdicts (`passed`, `bug_exposed`, `assertion_failed`).

## 3. Remediate Failures with Zod Contract Guards
Verdicts: `bug_exposed` = the target crashed with a 5xx; `assertion_failed` = wrong status (e.g. a live API accepted bad input with 2xx), SLA breach, or no HTTP response.
1. Read the failing scenarios' `lastResponseJson`. Sandbox crashes include the real exception name, message, and stack frames; diagnose from those, not from the scenario title.
2. Call `update-endpoint` with a `contractZodSchema` written in real Zod syntax. It validates the JSON body, e.g. `z.object({ quantity: z.number().int().min(1), couponCode: z.string().optional() })`. To validate headers, use an envelope: `z.object({ headers: z.object({ "x-idempotency-key": z.string().regex(/^idem_[A-Za-z0-9_]+$/) }) })` (lowercase header names). Do not use `.refine`, `.transform`, or functions; they are rejected.
3. If `update-endpoint` returns `invalid_contract`, fix the syntax error it reports and retry.
4. Re-run `run-scenarios` and confirm failing scenarios now return `422` and pass while baseline scenarios still pass. If a baseline breaks, the guard is too strict: loosen it and re-run.
5. Report the before/after counts to the user.

## 4. Ship the Fix

A `passed` run under a guard means ReqLab's gateway blocked the input; the real API still needs the check. After a guard turns failures into `422`s, offer `export-contract-guard` (`express`, `hono`, or `fetch`) and show the user the code, or point them to **Export as Middleware** in the guard panel.

## 5. Real Targets, Credentials, and Webhooks

- Local APIs: in development, `http://localhost:PORT/...` targets work; production blocks loopback.
- Credentials: never write a real token into headers and never ask for one in chat. Use `{{secret:REQLAB_TARGET_API_KEY}}` (or `_2`, or `REQLAB_WEBHOOK_SIGNING_SECRET`). On `missing_secret`, tell the user to add the key in Settings → API keys.
- Webhook receivers: `enable-webhook-inbox` gives a public `/hooks/<token>` URL. After real deliveries arrive, `list-webhook-captures` and replay interesting ones with `create-scenario` (`headersJson` = `replayHeadersJson`, `bodyJson` = `bodyText`), then mutate them into adversarial variants (replayed event ids, tampered signatures, missing idempotency keys).

## 6. Bug Hunt (adaptive, agent-driven)

When asked to "hunt", "find bugs", or "break" an endpoint, loop with `attack-batch` instead of guessing once:

1. Round 1: call `attack-batch` with 5–6 attacks spanning categories (boundary, injection, auth, idempotency, schema-fuzz, malformed/oversized). Set each `expectedStatus` to what a correct API should return (usually 4xx).
2. Read the results. `bug_exposed` = real 5xx crash; `assertion_failed` = wrong status (e.g. accepted bad input). Use each `responseExcerpt`/`bugSummary` to design a sharper round focused on whatever leaked a stack trace or behaved oddly.
3. Narrate one short line per round so the user sees the reasoning. Stop at the first crash or after ~4 rounds, then diagnose from the real error, guard it with `update-endpoint`, re-run, and offer `export-contract-guard`.

## 7. Import an API

`import-openapi` with a `specUrl` (or `specText`) creates one endpoint per operation plus first-wave attacks. After importing, `run-scenarios` or Bug Hunt each endpoint. It de-dupes by method+URL, so re-importing is safe.
