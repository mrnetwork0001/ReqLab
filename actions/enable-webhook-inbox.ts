import { randomBytes } from "node:crypto";

import { defineAction, defineActionErrors } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const errors = defineActionErrors("not_found");

export default defineAction({
  description:
    "Enable (or rotate) an endpoint's public webhook inbox. Returns inboxPath (`/hooks/<token>`); prefix it with the app's origin and point a real provider at it (e.g. `stripe listen --forward-to <origin>/hooks/<token>`). Captured requests appear in list-webhook-captures and can be saved as scenarios with create-scenario. Rotating invalidates the old URL. Requires editor access.",
  schema: z.object({
    endpointId: z.string().min(1).describe("Endpoint id from list-endpoints"),
    rotate: z
      .boolean()
      .default(false)
      .describe("Issue a new token even if the inbox is already enabled"),
  }),
  outputSchema: z.object({
    endpointId: z.string(),
    inboxPath: z.string(),
    rotated: z.boolean(),
  }),
  errors,
  mcpAnnotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  run: async ({ endpointId, rotate }) => {
    const { endpoints, endpointShares } = schema;
    const [endpoint] = await getDb()
      .select({ id: endpoints.id, inboxToken: endpoints.inboxToken })
      .from(endpoints)
      .where(
        and(
          eq(endpoints.id, endpointId),
          accessFilter(endpoints, endpointShares, undefined, "editor"),
        ),
      )
      .limit(1);
    if (!endpoint) {
      return errors.noWrite("Endpoint not found.", "not_found", { statusCode: 404 });
    }

    if (endpoint.inboxToken && !rotate) {
      return { endpointId, inboxPath: `/hooks/${endpoint.inboxToken}`, rotated: false };
    }

    const token = `wh_${randomBytes(18).toString("base64url")}`;
    await getDb()
      .update(endpoints)
      .set({ inboxToken: token, updatedAt: new Date().toISOString() })
      .where(eq(endpoints.id, endpointId));
    return { endpointId, inboxPath: `/hooks/${token}`, rotated: Boolean(endpoint.inboxToken) };
  },
});
