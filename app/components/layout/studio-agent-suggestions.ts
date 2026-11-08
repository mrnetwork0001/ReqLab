import type { AgentSuggestionItem } from "@agent-native/toolkit/composer";

interface EndpointSummary {
  id: string;
  name: string;
  method: string;
  targetUrl: string;
  contractZodSchema?: string;
}

interface ScenarioSummary {
  title: string;
  lastVerdict: string;
  bugSummary: string | null;
}

export interface StudioAgentContext {
  empty: string;
  placeholder: string;
  suggestions: AgentSuggestionItem[];
}

/** Agent panel copy and one-click prompts for the screen the user is on. */
export function studioAgentContext(input: {
  endpoint?: EndpointSummary | null;
  scenarios?: ScenarioSummary[];
  endpointCount?: number;
  totalCrashes?: number;
}): StudioAgentContext {
  const { endpoint, scenarios = [] } = input;

  if (endpoint) {
    const crashes = scenarios.filter((s) => s.lastVerdict === "bug_exposed");
    const mismatches = scenarios.filter((s) => s.lastVerdict === "assertion_failed");
    const untested = scenarios.filter((s) => s.lastVerdict === "untested").length;
    const guarded = Boolean(endpoint.contractZodSchema?.trim());
    const label = `${endpoint.method} ${endpoint.targetUrl}`;
    const suggestions: AgentSuggestionItem[] = [];

    if (crashes.length > 0) {
      suggestions.push({
        id: "fix-crashes",
        label: `Fix ${crashes.length} crash${crashes.length === 1 ? "" : "es"} on ${endpoint.name}`,
        prompt: `On "${endpoint.name}" (${label}), ${crashes.length} scenario(s) crash with a 500:\n${crashes
          .map((s) => `- "${s.title}": ${s.bugSummary ?? "500"}`)
          .join("\n")}\nDiagnose the root cause of each from the real error, write a Zod contract guard with update-endpoint that rejects those inputs with 422 without breaking the baseline, re-run the Chaos Matrix, and report before/after.`,
      });
    }
    if (mismatches.length > 0) {
      suggestions.push({
        id: "fix-mismatches",
        label: `Explain ${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}`,
        prompt: `Explain why these scenarios on "${endpoint.name}" did not return the expected status, and whether each one is an API bug or a wrong expectation:\n${mismatches
          .map((s) => `- "${s.title}": ${s.bugSummary ?? ""}`)
          .join("\n")}`,
      });
    }
    suggestions.push({
      id: "fuzz",
      label: "Attack this endpoint with 5 new scenarios",
      prompt: `Look at "${endpoint.name}" (${label}) and its existing scenarios, then create 5 new adversarial scenarios that cover gaps (boundary values, type confusion, injection, auth, idempotency/replay), each with the status a correct API should return. Run the Chaos Matrix and summarize what broke.`,
    });
    if (guarded) {
      suggestions.push({
        id: "ship",
        label: "Ship the guard as Express middleware",
        prompt: `Export the contract guard on "${endpoint.name}" as Express middleware with export-contract-guard, show me the code, and tell me where to mount it.`,
      });
    }
    if (untested > 0 && crashes.length === 0) {
      suggestions.unshift({
        id: "run",
        label: `Run the Chaos Matrix (${untested} untested)`,
        prompt: `Run every scenario on "${endpoint.name}" and explain the results.`,
      });
    }

    const status =
      crashes.length > 0
        ? `${crashes.length} scenario${crashes.length === 1 ? "" : "s"} crash with a 500 right now.`
        : mismatches.length > 0
          ? `${mismatches.length} scenario${mismatches.length === 1 ? "" : "s"} return the wrong status.`
          : guarded
            ? "Guarded and passing. Want me to try harder to break it?"
            : "No crashes yet. Want me to try harder to break it?";
    return {
      empty: `I'm looking at ${endpoint.name}. ${status}`,
      placeholder: `Ask the ReqLab agent about ${endpoint.name}…`,
      suggestions: suggestions.slice(0, 4),
    };
  }

  const count = input.endpointCount ?? 0;
  const crashes = input.totalCrashes ?? 0;
  if (count === 0) {
    return {
      empty: "I break APIs on purpose, find the real crash, and write the guard that fixes it.",
      placeholder: "Give the ReqLab agent an API to break…",
      suggestions: [
        {
          id: "seed",
          label: "Load the demo suite and break it",
          prompt: "Seed the demo suite, run every Chaos Matrix, and tell me which endpoints crash and why.",
        },
        {
          id: "local",
          label: "Test my local API on localhost:3000",
          prompt: "I have an API running at http://localhost:3000. Ask me for one route and a sample request body, create the endpoint, generate adversarial scenarios for it, and run them.",
        },
        {
          id: "public",
          label: "Stress-test a public HTTPS API",
          prompt: "Create an endpoint for POST https://jsonplaceholder.typicode.com/posts (expects 201), generate adversarial scenarios, run them, and tell me what it wrongly accepts.",
        },
      ],
    };
  }
  return {
    empty:
      crashes > 0
        ? `${count} endpoints under test, ${crashes} crash${crashes === 1 ? "" : "es"} open. I can fix them for you.`
        : `${count} endpoints under test and no open crashes. Want me to dig deeper?`,
    placeholder: "Ask the ReqLab agent to fuzz, diagnose, or guard an endpoint…",
    suggestions: [
      ...(crashes > 0
        ? [
            {
              id: "fix-all",
              label: `Fix all ${crashes} open crashes`,
              prompt:
                "For every endpoint with bug_exposed scenarios: diagnose each crash from the real error, apply a Zod contract guard with update-endpoint, re-run its Chaos Matrix, and give me a before/after table.",
            },
          ]
        : []),
      {
        id: "audit",
        label: "Rank endpoints by risk",
        prompt:
          "Audit every endpoint: which are unguarded, which crash, which accept bad input, and what attack categories are missing. Rank them by risk and suggest the next scenario for each.",
      },
      {
        id: "local",
        label: "Add my local API on localhost:3000",
        prompt:
          "I have an API running at http://localhost:3000. Ask me for one route and a sample request body, create the endpoint, generate adversarial scenarios for it, and run them.",
      },
    ],
  };
}
