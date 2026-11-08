import { defineAction } from "@agent-native/core/action";
import { writeAppStateForCurrentTab } from "@agent-native/core/application-state";
import { z } from "zod";

export default defineAction({
  description:
    "Navigate ReqLab to a specific view, endpoint studio page, or scenario tab.",
  schema: z.object({
    view: z
      .string()
      .optional()
      .describe('View name to navigate to, e.g. "studio" or "chat"'),
    path: z
      .string()
      .optional()
      .describe('URL path to navigate to, e.g. "/studio/<endpointId>"'),
    endpointId: z
      .string()
      .optional()
      .describe("Endpoint ID to open in ReqLab Studio"),
    scenarioId: z
      .string()
      .optional()
      .describe("Optional Scenario ID to focus in the Studio inspector"),
    tab: z
      .string()
      .optional()
      .describe('Optional Studio tab: "matrix", "contract", or "runs"'),
    threadId: z.string().optional().describe("Chat thread ID to open"),
  }),
  http: false,
  run: async (args) => {
    if (!args.view && !args.path && !args.endpointId) {
      throw new Error("At least --view, --path, or --endpointId is required.");
    }
    const nav: Record<string, string> = {};
    if (args.view) nav.view = args.view;
    if (args.endpointId) {
      nav.view = "studio";
      nav.endpointId = args.endpointId;
    }
    if (args.scenarioId) nav.scenarioId = args.scenarioId;
    if (args.tab) nav.tab = args.tab;
    if (args.path) {
      nav.path = args.path;
    } else if (args.endpointId) {
      const qs = new URLSearchParams();
      if (args.scenarioId) qs.set("scenarioId", args.scenarioId);
      if (args.tab) qs.set("tab", args.tab);
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      nav.path = `/studio/${encodeURIComponent(args.endpointId)}${suffix}`;
    }
    if (args.threadId) nav.threadId = args.threadId;
    nav._writeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeAppStateForCurrentTab("navigate", nav);
    return `Navigating to ${nav.path || args.view}`;
  },
});
