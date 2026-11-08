# ReqLab — Agent Guide

ReqLab is an Agent-Native API, webhook, and chaos testing studio. `/` opens shared sign-in, then lands on `/studio` (`app.homePath`). The Studio is the primary workflow; chat lives at `/chat`. Actions carry every capability; the Studio screens show and edit the same data the agent works on.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/build-an-app/SKILL.md` — start here for vague requests to create a domain app. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`. For external-agent integrations, read `pnpm action docs-search --slug "external-agents"`.

## Core rules

- UI feedback: target 100 ms, never exceed 400 ms; acknowledge before network work.
- Normal app data must flow through actions. Keep actions deterministic and focused; use agent chat/AgentSidebar for AI work and follow-ups in the same thread. Keep structured state in SQL and large files in configured storage; persist references only.
- For external integrations, inspect the workspace/provider connection catalog first; reuse its scoped resolver. Never hardcode credentials, webhook URLs, or private/customer data.
- Never fabricate. Report failures and recover; verify writes by reading the row or screen. Navigation is in `<current-screen>`; use `view-screen` for fresh visible-record details.

For custom branding, keep `server/plugins/agent-native-email-branding.ts` aligned: `app.name` appears in transactional email and optional `app.logoUrl` must be an absolute HTTPS URL.

## Application state

- `navigation` describes the view and selected ids. The Studio is `studio` at `/studio` and `/studio/<endpointId>`; chat is `chat` at `/chat` and `/chat/<threadId>`; `/home` is the template Get started page and is not linked.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.

## Working on ReqLab

Domain guidance lives in `.agents/skills/api-chaos-testing/SKILL.md`; read it before generating scenarios, diagnosing failures, or writing contract guards. Server logic: `server/lib/runner.ts` (gateway guard, sandbox vs. external fetch, verdicts), `server/lib/sandbox-apis.ts` (sandbox APIs with real bugs), `server/lib/contract-guard.ts` (safe Zod compiler). Use `adding-a-feature` for parity and `frontend-design` for user-facing screens. Keep the Studio link in `app/components/layout/Sidebar.tsx` before `ChatThreadsSection`.

After edits, run `pnpm typecheck`, `pnpm test` (guard compiler and sandbox crash/fix suite), `pnpm agent-native:doctor` (fix findings before done), and one browser smoke of `/studio`: seed the demo suite, run the Checkout Chaos Matrix (2 real `500` crashes), apply the checkout guard, re-run (all pass), and confirm the authenticated landing goes to `/studio`. Skip the production build.

Before building common workspace or agent UI, read `agent-native-toolkit`; for supported customization, read `customizing-agent-native`.

## ReqLab Studio

Stress-test APIs and webhooks, run adversarial chaos matrices, uncover 500 crashes, and apply Zod contract guards. `/studio` lists endpoints; `/studio/:endpointId?scenarioId=<id>` is the Chaos Matrix, Payload Editor, and Zod Contract Guard Studio. Chat stays at `/chat`.

- Endpoints are org-visible when an organization is active and private to their creator otherwise. Test scenarios and scenario runs belong to an endpoint and inherit its access. Viewers can read; changing or running anything (update/delete endpoint, create/update/delete scenario, run-scenarios) requires editor access.
- `create-endpoint` rejects duplicate `(method, targetUrl)` with `endpoint_conflict` (409). `create-scenario` locks the parent endpoint and rejects duplicate scenario `title` with `scenario_conflict` (409); report conflicts instead of retrying with another name unless asked.
- Targets: `/sandbox/*` (in-process APIs with real bugs), any public `https://` URL (SSRF-guarded), or `http://localhost:PORT` in development only (production blocks loopback).
- Never put real tokens in headers. Reference `{{secret:REQLAB_TARGET_API_KEY}}`, `{{secret:REQLAB_TARGET_API_KEY_2}}`, or `{{secret:REQLAB_WEBHOOK_SIGNING_SECRET}}`; the user sets values in Settings → API keys. `run-scenarios` returns `missing_secret` (422) when one is unset; ask the user to add it, don't ask for the value in chat.
- Bug Hunt: drive `attack-batch` in a loop. Each round, read every `responseExcerpt`/`bugSummary`, then design a sharper next batch aimed at whatever leaked a stack trace or accepted bad input. `bug_exposed` = real 5xx crash; `assertion_failed` = wrong status. Stop at the first crash (or ~4 rounds), then diagnose and guard it.
- Import: `import-openapi` with a `specUrl` creates endpoints + first-wave attacks; then `run-scenarios` or `attack-batch` each one. It de-dupes by method+URL.
- On Studio pages `navigation` adds `endpointId`, `scenarioId`, and `tab`; tab selection also writes `selection`.

| Action | Purpose |
| --- | --- |
| list-endpoints | List endpoints with pass and 500 bug counts |
| get-endpoint | Get endpoint spec, scenarios, and recent runs |
| create-endpoint | Create an API or webhook endpoint (409 on duplicate method+URL) |
| update-endpoint | Update endpoint spec or apply a Zod contractZodSchema guard (`invalid_contract` 422 if it does not compile) |
| delete-endpoint | Delete an endpoint with its scenarios, runs, and shares (editor access) |
| create-scenario | Add a baseline or adversarial chaos scenario (409 on duplicate title) |
| update-scenario | Update a scenario's payload, headers, or expected status |
| delete-scenario | Delete a scenario |
| run-scenarios | Execute one scenario or the full Chaos Matrix for an endpoint |
| import-openapi | Import an OpenAPI 3.x / Swagger 2.0 spec (URL or text) into one endpoint per operation, each seeded with a baseline + derived attack scenarios |
| attack-batch | One Bug Hunt round: persist a batch of adversarial attacks, run them live, and return real statuses + response excerpts so the agent can escalate |
| export-contract-guard | Export the saved guard as Express, Hono, or Fetch middleware to ship in the real API |
| enable-webhook-inbox | Create or rotate the endpoint's public inbox URL `/hooks/<token>` (editor) |
| list-webhook-captures | List real captured deliveries; pass `replayHeadersJson` and `bodyText` to create-scenario to replay one |
| seed-demo-suite | Seed 3 sandbox APIs with real bugs, 1 live HTTPS API, and 12 chaos scenarios |
