import {
  appBasePath,
  appPathFromLocalRoute,
} from "@agent-native/core/client/api-path";
import { useAgentRouteState } from "@agent-native/core/client/navigation";

import {
  chatThreadPath,
  HOME_PATH,
  isChatPathname,
  NEW_CHAT_PATH,
  threadIdFromPath,
} from "@/lib/chat-paths";
import { TAB_ID } from "@/lib/tab-id";

export interface NavigationState {
  view?: string;
  path?: string;
  publicPath?: string;
  threadId?: string;
  endpointId?: string;
  scenarioId?: string;
  tab?: string;
}

export function useNavigationState() {
  useAgentRouteState<NavigationState>({
    browserTabId: TAB_ID,
    requestSource: TAB_ID,
    getNavigationState: ({ pathname, searchParams }) =>
      navigationStateForPath(pathname, searchParams),
    getCommandPath: commandPathForNavigation,
  });
}

export function commandPathForNavigation(command: NavigationState): string {
  const fallbackPath = pathForCommand(command);
  const path = typeof command?.path === "string" ? command.path : "";
  if (!path) return fallbackPath;

  const basePath = appBasePath();
  if (!basePath) return path;

  const suffixIndex = path.search(/[?#]/);
  const pathname = suffixIndex === -1 ? path : path.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? "" : path.slice(suffixIndex);
  const publicPath =
    typeof command?.publicPath === "string" ? command.publicPath : "";
  const publicPathSuffixIndex = publicPath.search(/[?#]/);
  const declaredPublicPath =
    publicPathSuffixIndex === -1
      ? publicPath
      : publicPath.slice(0, publicPathSuffixIndex);
  const publicViewPath = appPathFromLocalRoute(pathForView(command?.view));
  if (
    matchesPathPrefix(pathname, basePath) &&
    (matchesPathPrefix(pathname, publicViewPath) ||
      (declaredPublicPath && declaredPublicPath === pathname))
  ) {
    return `${pathname.slice(basePath.length) || "/"}${suffix}`;
  }
  return path;
}

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function navigationStateForPath(
  pathname: string,
  searchParams?: URLSearchParams,
): NavigationState {
  const threadId = threadIdFromPath(pathname);
  const endpointMatch = pathname.match(/^\/studio\/([^/?#]+)/);
  const endpointId = endpointMatch?.[1]
    ? safeDecode(endpointMatch[1])
    : undefined;
  const scenarioId = searchParams?.get("scenarioId") ?? undefined;
  const tab = searchParams?.get("tab") ?? undefined;

  return {
    view: viewForPath(pathname),
    path: pathname,
    publicPath: appPathFromLocalRoute(pathname),
    ...(threadId ? { threadId } : {}),
    ...(endpointId ? { endpointId } : {}),
    ...(scenarioId ? { scenarioId } : {}),
    ...(tab ? { tab } : {}),
  };
}

function viewForPath(pathname: string): string {
  if (pathname.startsWith("/studio")) return "studio";
  if (isChatPathname(pathname)) return "chat";
  if (pathname === HOME_PATH) return "home";
  if (pathname.startsWith("/database")) return "database";
  if (pathname.startsWith("/extensions")) return "extensions";
  if (pathname.startsWith("/observability")) return "observability";
  if (pathname.startsWith("/settings/agent") || pathname.startsWith("/agent")) {
    return "agent";
  }
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/team")) return "settings";
  return "chat";
}

function pathForView(view?: string): string {
  switch (view) {
    case "studio":
      return "/studio";
    case "chat":
    case "ask":
      return NEW_CHAT_PATH;
    case "home":
      return HOME_PATH;
    case "database":
      return "/database";
    case "extensions":
      return "/extensions";
    case "observability":
      return "/observability";
    case "agent":
      return "/settings/agent";
    case "settings":
      return "/settings";
    case "team":
      return "/settings/organization";
    default:
      return "/studio";
  }
}

export function pathForCommand(command: any): string {
  if (command?.endpointId) {
    const qs = new URLSearchParams();
    if (command?.scenarioId) qs.set("scenarioId", String(command.scenarioId));
    if (command?.tab) qs.set("tab", String(command.tab));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return `/studio/${encodeURIComponent(String(command.endpointId))}${suffix}`;
  }
  const path = pathForView(command?.view);
  if (command?.view !== "chat" && command?.view !== "ask") return path;
  const threadId =
    typeof command?.threadId === "string" ? command.threadId.trim() : "";
  return threadId ? chatThreadPath(threadId) : path;
}

/** A malformed escape like `/studio/%E0` must not crash the app shell. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
