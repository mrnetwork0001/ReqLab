import { createToolkitAuthPlugin } from "@agent-native/toolkit/app/auth/server";

export default createToolkitAuthPlugin({
  // `/hooks/<token>` is the public webhook inbox: providers post to it without
  // a session, and the route authenticates by its unguessable per-endpoint token.
  publicPaths: ["/hooks"],
  workspaceAppPublicPaths: ["/", "/hooks"],
  rootAuth: true,
  // The sign-in page at "/" is the first thing a visitor from the demo or the
  // repo sees, so it carries the pitch instead of a bare form.
  marketing: {
    appName: "ReqLab",
    tagline: "Break your APIs on purpose.",
    description:
      "An agent-native API, webhook, and chaos-testing studio. The agent fires adversarial payloads until an endpoint throws a real 500, reads the actual stack trace, writes the Zod contract guard that fixes it, and re-runs to prove it.",
    features: [
      "Chaos Matrix — injection, type confusion, and boundary payloads against any endpoint",
      "Bug Hunt — the agent escalates each round until it exposes a real 500",
      "Zod contract guards — every crash becomes a clean 422, exportable as middleware",
      "Import an OpenAPI spec and auto-derive attacks for every operation",
    ],
    learnMoreUrl: "https://github.com/mrnetwork0001/ReqLab",
  },
});
