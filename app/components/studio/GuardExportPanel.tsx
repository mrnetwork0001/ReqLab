import { actionErrorMessage, useActionQuery } from "@agent-native/core/client/hooks";
import { IconCheck, IconCopy, IconFileExport } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

const FRAMEWORKS = [
  { id: "express", label: "Express" },
  { id: "hono", label: "Hono" },
  { id: "fetch", label: "Fetch (Next.js, Workers)" },
] as const;

type Framework = (typeof FRAMEWORKS)[number]["id"];

/** Exports the saved contract guard as middleware for the real API. */
export function GuardExportPanel({
  endpointId,
  hasSavedGuard,
}: {
  endpointId: string;
  hasSavedGuard: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [framework, setFramework] = useState<Framework>("express");
  const [copied, setCopied] = useState(false);
  const { data, error, isFetching } = useActionQuery(
    "export-contract-guard",
    { endpointId, framework },
    { enabled: open && hasSavedGuard },
  );

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!hasSavedGuard}
        title={hasSavedGuard ? undefined : "Save a contract guard first"}
        onClick={() => setOpen(true)}
      >
        <IconFileExport className="mr-1.5 size-3.5" />
        Export as Middleware
      </Button>
    );
  }

  const copy = async () => {
    if (!data?.code) return;
    await navigator.clipboard.writeText(data.code);
    setCopied(true);
    toast.success(`Copied ${data.filename}`);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="w-full space-y-2 rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">
          Ship this guard in your API
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {FRAMEWORKS.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={framework === option.id ? "secondary" : "ghost"}
              onClick={() => setFramework(option.id)}
            >
              {option.label}
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-destructive">
          {actionErrorMessage(error) ?? "Could not export the guard."}
        </p>
      ) : (
        <div className="relative">
          <pre className="max-h-72 overflow-auto rounded-md border border-border bg-card p-3 font-mono text-[11px] leading-relaxed">
            {data?.code ?? (isFetching ? "Generating…" : "")}
          </pre>
          {data?.code ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="absolute right-2 top-2"
              onClick={() => void copy()}
            >
              {copied ? (
                <IconCheck className="mr-1 size-3.5" />
              ) : (
                <IconCopy className="mr-1 size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        ReqLab enforces the guard as a gateway during runs. Paste this into the
        real service so the fix holds in production too.
      </p>
    </div>
  );
}
