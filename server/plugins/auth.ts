import { createToolkitAuthPlugin } from "@agent-native/toolkit/app/auth/server";

export default createToolkitAuthPlugin({
  // `/hooks/<token>` is the public webhook inbox: providers post to it without
  // a session, and the route authenticates by its unguessable per-endpoint token.
  publicPaths: ["/hooks"],
  workspaceAppPublicPaths: ["/", "/hooks"],
  rootAuth: true,
  marketing: false,
});
