import { navigateWithAgentChatViewTransition } from "@agent-native/core/client/agent-chat";
import { useActionQuery } from "@agent-native/core/client/hooks";
import { focusAgentChat } from "@agent-native/toolkit/app/chat";
import { AgentSidebar } from "@agent-native/toolkit/app/chat";
import { type ReactNode, useMemo } from "react";
import { useLocation, useNavigate } from "react-router";

import { ChatComposerContextProvider } from "@/components/ChatComposerContext";
import { chatThreadPath } from "@/lib/chat-paths";
import { TAB_ID } from "@/lib/tab-id";

import { studioAgentContext } from "./studio-agent-suggestions";

interface AgentInspectorProps {
  children: ReactNode;
  chatHomeHandoffActive: boolean;
  chatHomeHandoffPending: boolean;
}

function endpointIdFromPath(pathname: string): string | null {
  const match = /^\/studio\/([^/?#]+)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** The ReqLab agent panel: copy and prompts follow the endpoint on screen. */
export function AgentInspector({
  children,
  chatHomeHandoffActive,
  chatHomeHandoffPending,
}: AgentInspectorProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const endpointId = endpointIdFromPath(location.pathname);

  const endpointParams = useMemo(() => ({ id: endpointId ?? "" }), [endpointId]);
  const { data: detail } = useActionQuery("get-endpoint", endpointParams, {
    enabled: Boolean(endpointId),
  });
  const { data: list } = useActionQuery("list-endpoints", {});

  const context = useMemo(
    () =>
      studioAgentContext({
        endpoint: endpointId ? (detail?.endpoint ?? null) : null,
        scenarios: endpointId ? (detail?.scenarios ?? []) : [],
        endpointCount: list?.endpoints.length ?? 0,
        totalCrashes: (list?.endpoints ?? []).reduce((sum, e) => sum + e.bugsExposedCount, 0),
      }),
    [endpointId, detail, list],
  );

  function openAskAgentFullscreen(threadId?: string) {
    focusAgentChat();
    navigateWithAgentChatViewTransition(navigate, chatThreadPath(threadId));
  }

  return (
    <AgentSidebar
      composerContextProvider={ChatComposerContextProvider}
      position="right"
      chatViewTransition
      chatViewTransitionHandoff={chatHomeHandoffPending}
      storageKey="chat"
      openStorageKey="reqlab-agent-open-v2"
      browserTabId={TAB_ID}
      openOnChatRunning={chatHomeHandoffActive}
      onFullscreenRequest={openAskAgentFullscreen}
      emptyStateText={context.empty}
      composerPlaceholder={context.placeholder}
      agentPageHref="/settings/agent"
      suggestions={context.suggestions}
      dynamicSuggestions={false}
      defaultOpen
    >
      {children}
    </AgentSidebar>
  );
}
