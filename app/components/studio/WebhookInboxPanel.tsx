import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { IconCopy, IconInbox, IconPlus, IconRefresh } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function prettyBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return new Date(iso).toLocaleString();
}

/**
 * Public inbox for real webhook deliveries. Providers post to /hooks/<token>;
 * captures show up here and can be saved as replayable chaos scenarios.
 */
export function WebhookInboxPanel({
  endpointId,
  existingTitles,
}: {
  endpointId: string;
  existingTitles: string[];
}) {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const params = { endpointId, limit: 20 };
  const { data, isPending } = useActionQuery("list-webhook-captures", params, {
    // Deliveries arrive from outside the app, so poll while the inbox is open.
    refetchInterval: (query) =>
      (query.state.data as { inboxPath?: string | null } | undefined)?.inboxPath ? 4000 : false,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["action", "list-webhook-captures"] });

  const enable = useActionMutation("enable-webhook-inbox", {
    onSuccess: (result) => {
      toast.success(result.rotated ? "Inbox URL rotated" : "Webhook inbox is live");
      void refresh();
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? "Could not enable the inbox."),
  });

  const createScenario = useActionMutation("create-scenario", {
    onSuccess: () => toast.success("Saved capture as a scenario"),
    onError: (error) => toast.error(actionErrorMessage(error) ?? "Could not save the scenario."),
  });

  const inboxUrl =
    data?.inboxPath && typeof window !== "undefined"
      ? `${window.location.origin}${data.inboxPath}`
      : null;
  const captures = data?.captures ?? [];

  const saveAsScenario = (capture: (typeof captures)[number]) => {
    const base = `Captured ${capture.method} ${new Date(capture.receivedAt).toLocaleTimeString()}`;
    let title = base;
    for (let n = 2; existingTitles.includes(title); n++) title = `${base} (${n})`;
    createScenario.mutate({
      endpointId,
      title,
      category: "baseline",
      headersJson: capture.replayHeadersJson,
      bodyJson: capture.bodyText,
      expectedStatus: 200,
      authoredBy: "human",
    });
  };

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <IconInbox className="size-4 text-sky-500" />
          <strong className="text-sm font-semibold">Webhook Inbox</strong>
        </div>
        {inboxUrl ? (
          <Badge variant="outline" className="text-xs">
            {captures.length} captured
          </Badge>
        ) : null}
      </div>

      {isPending ? null : !inboxUrl ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Get a public URL that records real deliveries from Stripe, GitHub,
            Shopify, or your own service. Save any capture as a scenario and
            replay it against this endpoint.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={enable.isPending}
            onClick={() => enable.mutate({ endpointId, rotate: false })}
          >
            <IconPlus className="mr-1.5 size-3.5" />
            Create Inbox URL
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px]">
              {inboxUrl}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(inboxUrl);
                toast.success("Inbox URL copied");
              }}
            >
              <IconCopy className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              title="Rotate URL (the old one stops working)"
              disabled={enable.isPending}
              onClick={() => enable.mutate({ endpointId, rotate: true })}
            >
              <IconRefresh className="size-3.5" />
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-md bg-background p-2 font-mono text-[10px] text-muted-foreground">
            {`stripe listen --forward-to ${inboxUrl}\ncurl -X POST ${inboxUrl} -H 'content-type: application/json' -d '{"eventId":"evt_1"}'`}
          </pre>

          {captures.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Waiting for the first delivery…
            </p>
          ) : (
            <div className="max-h-80 space-y-1.5 overflow-y-auto">
              {captures.map((capture) => (
                <div
                  key={capture.id}
                  className="rounded-lg border border-border bg-background text-xs"
                >
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left"
                    onClick={() =>
                      setExpandedId(expandedId === capture.id ? null : capture.id)
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="font-mono font-semibold">{capture.method}</span>
                      <span className="truncate text-muted-foreground">
                        {capture.contentType || "no content-type"} · {capture.sizeBytes} B
                        {capture.truncated ? " (truncated)" : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {timeAgo(capture.receivedAt)}
                    </span>
                  </button>
                  {expandedId === capture.id ? (
                    <div className="space-y-2 border-t border-border p-2.5">
                      <pre className="max-h-32 overflow-auto font-mono text-[10px] text-muted-foreground">
                        {capture.replayHeadersJson}
                      </pre>
                      <pre className="max-h-40 overflow-auto font-mono text-[11px]">
                        {prettyBody(capture.bodyText) || "(empty body)"}
                      </pre>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={createScenario.isPending}
                        onClick={() => saveAsScenario(capture)}
                      >
                        <IconPlus className="mr-1.5 size-3.5" />
                        Save as Scenario
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
