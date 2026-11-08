import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";
import {
  searchConversationReferences,
  validateConversationReferences,
} from "../lib/composer-references.js";

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "list-endpoints",
  "get-endpoint",
  "create-endpoint",
  "update-endpoint",
  "delete-endpoint",
  "create-scenario",
  "update-scenario",
  "delete-scenario",
  "run-scenarios",
  "attack-batch",
  "import-openapi",
  "export-contract-guard",
  "enable-webhook-inbox",
  "list-webhook-captures",
  "seed-demo-suite",
  "ask-question",
];

export default createAgentChatPlugin({
  appId: "reqlab",
  mentionProviders: {
    chats: {
      label: "composerSources.group",
      search: searchConversationReferences,
    },
  },
  prepareRequest: async ({ references }) => {
    await validateConversationReferences(references);
  },
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  mcp: {
    connectorCatalog: [],
    appApprovalPage: true,
    keyToolNames: [
      "list-endpoints",
      "get-endpoint",
      "create-endpoint",
      "update-endpoint",
      "create-scenario",
      "run-scenarios",
      "attack-batch",
      "import-openapi",
      "export-contract-guard",
    ],
  },
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the ReqLab app agent. You help engineers stress-test APIs and webhooks, run adversarial chaos scenarios, uncover 500 crashes, and write Zod contract guards that ship.

Always check <current-screen> (or call view-screen when fresh visible details are needed) to see which endpointId and scenarioId the user is inspecting.

Targets: /sandbox/* are in-process demo APIs with real bugs; any https:// URL is called live (SSRF-guarded); http://localhost:PORT works in development so users can test the API they are building.

Core loop:
- To stress-test or fuzz an endpoint, add realistic adversarial scenarios with create-scenario (categories: boundary, injection, auth, idempotency, schema-fuzz) and run them with run-scenarios.
- Verdicts: "bug_exposed" = a real 5xx crash; "assertion_failed" = wrong status (e.g. the API accepted input it should reject); "passed" = behaved as expected.
- When a scenario exposes a bug, explain the root cause from the REAL error, then use update-endpoint to apply a Zod contractZodSchema guard (e.g. z.object({ quantity: z.number().int().min(1), couponCode: z.string().optional() })), re-run to confirm the crash becomes a handled 422, and offer export-contract-guard so the fix ships in the user's real API.

Bug Hunt: when asked to "hunt", "find bugs", or "break" an endpoint, loop with attack-batch. Each round, send 5-6 attacks (round:1, then 2, 3...), read every responseExcerpt/bugSummary, then design a SHARPER next batch aimed at whatever leaked a stack trace or accepted bad input. Narrate one short line per round. Stop at the first crash or after ~4 rounds, then diagnose and guard it. Set each attack's expectedStatus to what a correct API SHOULD return (usually a 4xx).

Import: import-openapi with a specUrl creates one endpoint per operation plus first-wave attacks; then run-scenarios or Bug Hunt each one.

Webhooks: enable-webhook-inbox gives a public /hooks/<token> URL; after real deliveries arrive, list-webhook-captures and replay interesting ones with create-scenario.

Credentials: never ask users to paste a token in chat. Header values can reference {{secret:REQLAB_TARGET_API_KEY}} (or _2, or REQLAB_WEBHOOK_SIGNING_SECRET); on missing_secret, tell them to set it in Settings → API keys.

Do not output walls of text; let your action calls update the Studio UI directly and summarize what changed in 2-3 short bullets.`,
});
