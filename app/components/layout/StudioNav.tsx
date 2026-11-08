import { useActionQuery } from "@agent-native/core/client/hooks";
import { IconBolt, IconLayoutGrid } from "@tabler/icons-react";
import { Link, useLocation } from "react-router";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** ReqLab product mark used in the sidebar header. */
export function ReqLabMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-rose-500 to-amber-500 text-white shadow-sm",
        className,
      )}
    >
      <IconBolt className="size-3.5" strokeWidth={2.4} />
    </span>
  );
}

function StatusDot({ bugs, mismatches, untested }: { bugs: number; mismatches: number; untested: number }) {
  const tone =
    bugs > 0
      ? "bg-rose-500"
      : mismatches > 0
        ? "bg-amber-500"
        : untested > 0
          ? "bg-muted-foreground/40"
          : "bg-emerald-500";
  return <span className={cn("size-2 shrink-0 rounded-full", tone)} />;
}

/**
 * Studio-first navigation: the endpoints under test, each with its live
 * crash count, so the sidebar reads as the product rather than a chat list.
 */
export function StudioNav({ collapsed }: { collapsed: boolean }) {
  const location = useLocation();
  const { data } = useActionQuery("list-endpoints", {});
  const endpoints = data?.endpoints ?? [];
  const overviewActive = location.pathname === "/studio" || location.pathname === "/studio/";
  const totalBugs = endpoints.reduce((sum, e) => sum + e.bugsExposedCount, 0);

  const overview = (
    <Link
      to="/studio"
      aria-current={overviewActive ? "page" : undefined}
      aria-label={collapsed ? "Endpoints" : undefined}
      className={cn(
        "flex items-center text-sidebar-accent-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        overviewActive && "bg-sidebar-accent",
        collapsed
          ? "relative size-8 justify-center rounded-md"
          : "h-8 w-full gap-3 rounded-lg px-3 text-sm font-medium",
      )}
    >
      <IconLayoutGrid className="size-4 shrink-0" strokeWidth={1.8} />
      {collapsed ? (
        totalBugs > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-rose-500 text-[9px] font-semibold text-white">
            {totalBugs > 9 ? "9+" : totalBugs}
          </span>
        ) : null
      ) : (
        <>
          <span className="flex-1 truncate">Endpoints</span>
          {totalBugs > 0 ? (
            <span className="rounded-full bg-rose-500/15 px-1.5 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
              {totalBugs} {totalBugs === 1 ? "crash" : "crashes"}
            </span>
          ) : null}
        </>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{overview}</TooltipTrigger>
        <TooltipContent side="right">Endpoints</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="px-2 pb-2">
      {overview}
      {endpoints.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {endpoints.map((endpoint) => {
            const path = `/studio/${encodeURIComponent(endpoint.id)}`;
            const active = location.pathname === path;
            return (
              <Link
                key={endpoint.id}
                to={path}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-7 w-full items-center gap-2.5 rounded-lg pl-4 pr-2 text-[13px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                <StatusDot
                  bugs={endpoint.bugsExposedCount}
                  mismatches={endpoint.assertionFailedCount}
                  untested={endpoint.untestedCount}
                />
                <span className="min-w-0 flex-1 truncate">{endpoint.name}</span>
                {endpoint.bugsExposedCount > 0 ? (
                  <span className="font-mono text-[11px] text-rose-600 dark:text-rose-400">
                    {endpoint.bugsExposedCount}
                  </span>
                ) : endpoint.assertionFailedCount > 0 ? (
                  <span className="font-mono text-[11px] text-amber-600 dark:text-amber-400">
                    {endpoint.assertionFailedCount}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
