import { createGetDb } from "@agent-native/core/db";
import { registerShareableResource } from "@agent-native/core/sharing";

import * as schema from "./schema.js";

export const getDb = createGetDb(schema);
export { schema };

registerShareableResource({
  type: "endpoint",
  resourceTable: schema.endpoints,
  sharesTable: schema.endpointShares,
  displayName: "Endpoint",
  titleColumn: "name",
  getResourcePath: (endpoint) => `/studio/${endpoint.id}`,
  agentRead: { actions: ["get-endpoint"] },
  getDb,
});
