import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { useAgentSelectable } from "@agent-native/toolkit/app/agent-select";
import { WaveBackground } from "@agent-native/toolkit/app/shared";
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconFlask,
  IconPlayerPlay,
  IconPlus,
  IconShieldCheck,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ReqLabMark } from "@/components/layout/StudioNav";
import { ImportSpecDialog } from "@/components/studio/ImportSpecDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

type EndpointItem = {
  id: string;
  name: string;
  method: string;
  targetUrl: string;
  expectedStatus: number;
  maxLatencyMs: number;
  hasContractGuard: boolean;
  lastRevisedBy: string;
  revisionCount: number;
  totalScenarios: number;
  passedCount: number;
  bugsExposedCount: number;
  assertionFailedCount: number;
  untestedCount: number;
};

function errorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "errorCode" in error &&
    typeof error.errorCode === "string"
  ) {
    return error.errorCode;
  }
  return undefined;
}

function MethodPill({ method }: { method: string }) {
  const upper = method.toUpperCase();
  const tone =
    upper === "GET"
      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
      : upper === "POST"
        ? "bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30"
        : upper === "DELETE"
          ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
          : "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs font-semibold ${tone}`}
    >
      {upper}
    </span>
  );
}

function EndpointCard({
  endpoint,
  onDelete,
   onRunQuick,
  runningId,
}: {
  endpoint: EndpointItem;
  onDelete: (id: string) => void;
  onRunQuick: (id: string) => void;
  runningId: string | null;
}) {
  const t = useT();
  const cardRef = useRef<HTMLElement>(null);
  const picked = useAgentSelectable({
    kind: "endpoint",
    id: endpoint.id,
    title: `${endpoint.method} ${endpoint.targetUrl}`,
    getContext: () =>
      `Endpoint id: ${endpoint.id} (${endpoint.method} ${endpoint.targetUrl}); use get-endpoint or run-scenarios`,
    getElement: () => cardRef.current,
  });

  return (
    <article
      ref={cardRef}
      className={`@container/card flex flex-col justify-between gap-4 rounded-xl border bg-card p-4 transition-colors ${
        picked
          ? "border-primary ring-2 ring-primary/30"
          : endpoint.bugsExposedCount > 0
            ? "border-rose-500/40"
            : endpoint.assertionFailedCount > 0
              ? "border-amber-500/40"
              : "border-border"
      }`}
    >
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <MethodPill method={endpoint.method} />
            <Link
              to={`/studio/${endpoint.id}`}
              className="truncate text-base font-semibold tracking-tight hover:underline"
            >
              {endpoint.name}
            </Link>
          </div>
          <Badge variant="outline" className="shrink-0 font-mono text-xs">
            v{endpoint.revisionCount} ·{" "}
            {endpoint.lastRevisedBy === "agent"
              ? t("studio.revisedByAgent")
              : t("studio.revisedByHuman")}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="truncate rounded bg-muted px-2 py-0.5">
            {endpoint.targetUrl}
          </span>
          <span>SLA ≤ {endpoint.maxLatencyMs}ms</span>
          {endpoint.hasContractGuard ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 font-sans text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <IconShieldCheck className="size-3.5" />
              {t("studio.contractGuarded")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 font-sans text-xs font-medium text-amber-600 dark:text-amber-400">
              {t("studio.unguarded")}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1 text-xs @xs/card:grid-cols-4">
          <div className="rounded-lg border border-border bg-background px-2.5 py-1.5">
            <span className="block truncate text-muted-foreground">
              {t("studio.passed")}
            </span>
            <strong className="mt-0.5 inline-flex items-center gap-1 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              <IconCheck className="size-3.5" />
              {endpoint.passedCount}/{endpoint.totalScenarios}
            </strong>
          </div>
          <div className="rounded-lg border border-border bg-background px-2.5 py-1.5">
            <span className="block truncate text-muted-foreground">
              {t("studio.bugsExposed")}
            </span>
            <strong
              className={`mt-0.5 inline-flex items-center gap-1 text-sm font-semibold ${
                endpoint.bugsExposedCount > 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-foreground"
              }`}
            >
              <IconAlertTriangle className="size-3.5" />
              {endpoint.bugsExposedCount}
            </strong>
          </div>
          <div className="rounded-lg border border-border bg-background px-2.5 py-1.5">
            <span className="block truncate text-muted-foreground">
              {t("studio.mismatches")}
            </span>
            <strong
              className={`mt-0.5 block text-sm font-semibold ${
                endpoint.assertionFailedCount > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-foreground"
              }`}
            >
              {endpoint.assertionFailedCount}
            </strong>
          </div>
          <div className="rounded-lg border border-border bg-background px-2.5 py-1.5">
            <span className="block truncate text-muted-foreground">
              {t("studio.untested")}
            </span>
            <strong className="mt-0.5 block text-sm font-semibold">
              {endpoint.untestedCount}
            </strong>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex items-center gap-2">
          <Button asChild size="sm">
            <Link to={`/studio/${endpoint.id}`}>{t("studio.openMatrix")}</Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={runningId === endpoint.id}
            onClick={() => onRunQuick(endpoint.id)}
          >
            <IconPlayerPlay className="mr-1.5 size-3.5" />
            {runningId === endpoint.id
              ? t("studio.runningScenarios")
              : t("studio.runScenario")}
          </Button>
        </div>
        {!endpoint.id.startsWith("pending-") ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("studio.confirmDelete")}
            onClick={() => onDelete(endpoint.id)}
          >
            <IconTrash className="size-4 text-muted-foreground" />
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export default function StudioIndexRoute() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const queryKey = ["action", "list-endpoints", {}];
  const { data, isPending } = useActionQuery("list-endpoints", {});

  const [name, setName] = useState("");
  const [method, setMethod] = useState<
    "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  >("POST");
  const [targetUrl, setTargetUrl] = useState("/sandbox/checkout");
  const [expectedStatus, setExpectedStatus] = useState("200");
  const [sampleBodyJson, setSampleBodyJson] = useState(
    '{"sku":"pro-seat","quantity":2,"unitPriceCents":4900}',
  );
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [runningEndpointId, setRunningEndpointId] = useState<string | null>(
    null,
  );

  const seed = useActionMutation("seed-demo-suite", {
    onSuccess: (res) => {
      toast.success(t("studio.seededSuccess"));
      if (res.firstEndpointId) {
        navigate(`/studio/${res.firstEndpointId}`);
      }
    },
    onError: (error) => {
      toast.error(actionErrorMessage(error) ?? t("studio.createFailed"));
    },
  });

  const createEndpoint = useActionMutation("create-endpoint", {
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(
        queryKey,
        (old: { endpoints: EndpointItem[] } | undefined) =>
          old && {
            endpoints: [
              ...old.endpoints,
              {
                id: "pending-" + Date.now(),
                name: input.name,
                method: input.method ?? "POST",
                targetUrl: input.targetUrl,
                expectedStatus: input.expectedStatus ?? 200,
                maxLatencyMs: 800,
                hasContractGuard: false,
                lastRevisedBy: "human",
                revisionCount: 1,
                totalScenarios: 1,
                passedCount: 0,
                bugsExposedCount: 0,
                assertionFailedCount: 0,
                untestedCount: 1,
              },
            ],
          },
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      queryClient.setQueryData(
        queryKey,
        (context as { previous?: unknown } | undefined)?.previous,
      );
      toast.error(
        errorCode(error) === "endpoint_conflict"
          ? t("studio.endpointConflict")
          : (actionErrorMessage(error) ?? t("studio.createFailed")),
      );
    },
    onSuccess: () => {
      setName("");
      toast.success(t("studio.endpointCreated"));
    },
  });

  const deleteEndpoint = useActionMutation("delete-endpoint", {
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(
        queryKey,
        (old: { endpoints: EndpointItem[] } | undefined) =>
          old && {
            endpoints: old.endpoints.filter((item) => item.id !== id),
          },
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      queryClient.setQueryData(
        queryKey,
        (context as { previous?: unknown } | undefined)?.previous,
      );
      toast.error(actionErrorMessage(error) ?? t("studio.deleteFailed"));
    },
    onSuccess: () => {
      setPendingDeleteId(null);
    },
  });

  const runMatrix = useActionMutation("run-scenarios", {
    onSettled: () => setRunningEndpointId(null),
    onSuccess: (res) => {
      if (res.bugsExposedCount > 0) {
        toast.error(
          `${res.bugsExposedCount} unhandled 500 crash(es) exposed across ${res.totalExecuted} scenarios!`,
        );
      } else {
        toast.success(
          res.assertionFailedCount > 0
            ? `${res.assertionFailedCount} contract mismatch(es) across ${res.totalExecuted} scenarios.`
            : `All ${res.passedCount}/${res.totalExecuted} scenarios passed.`,
        );
      }
    },
    onError: (error) => {
      toast.error(actionErrorMessage(error) ?? t("studio.createFailed"));
    },
  });

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !targetUrl.trim()) return;
    createEndpoint.mutate({
      name: name.trim(),
      method,
      targetUrl: targetUrl.trim(),
      expectedStatus: Number(expectedStatus) || 200,
      sampleBodyJson: sampleBodyJson.trim() || "{}",
    });
  }

  function handleAskAgentAudit() {
    sendToAgentChat({
      openSidebar: true,
      submit: true,
      message:
        "Audit our API endpoints: if none exist yet, call seed-demo-suite first. Then run-scenarios on the Checkout & Charge Ledger API, identify any 500 crashes exposed, and apply a Zod contractZodSchema guard to fix them.",
    });
  }

  if (isPending) {
    return (
      <div className="@container grid gap-4 p-4 sm:p-6 @3xl:grid-cols-2 @6xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, idx) => (
          <Skeleton key={idx} className="h-56 rounded-xl" />
        ))}
      </div>
    );
  }

  const endpoints = data?.endpoints ?? [];

  return (
    <div className="@container flex min-h-full flex-col gap-5 p-4 sm:p-6">
      <section className="relative isolate overflow-hidden rounded-2xl border border-border px-5 py-6 sm:px-7">
        <WaveBackground
          matchPageSurface
          className="pointer-events-none absolute inset-0 -z-10 opacity-50"
        />
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2.5">
              <ReqLabMark className="size-8 sm:size-9" />
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                ReqLab
              </h1>
            </div>
            <p className="max-w-lg text-sm text-muted-foreground">
              Break your APIs on purpose. The agent finds the real crash and
              writes the Zod guard that fixes it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="default"
              disabled={seed.isPending}
              onClick={() => seed.mutate({})}
            >
              <IconFlask className="mr-1.5 size-4" />
              {seed.isPending
                ? t("studio.seedingSandbox")
                : t("studio.seedSandbox")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleAskAgentAudit}
            >
              <IconSparkles className="mr-1.5 size-4" />
              {t("studio.askAgentAudit")}
            </Button>
            <ImportSpecDialog label={t("studio.importSpec")} />
          </div>
        </div>
      </section>

      <form
        onSubmit={handleSubmit}
        className="grid gap-3 rounded-xl border border-border bg-card p-4 @4xl:grid-cols-[minmax(10rem,1.2fr)_7rem_minmax(12rem,1.4fr)_6rem_minmax(12rem,1.5fr)_auto] @4xl:items-end"
      >
        <div className="space-y-1.5">
          <Label htmlFor="ep-name">{t("studio.endpointName")}</Label>
          <Input
            id="ep-name"
            placeholder="Checkout Charge API"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ep-method">{t("studio.endpointMethod")}</Label>
          <select
            id="ep-method"
            value={method}
            onChange={(e) =>
              setMethod(
                e.target.value as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
              )
            }
            className="flex h-9 w-full rounded-md border border-input bg-background px-2.5 py-1 text-sm"
          >
            <option value="POST">POST</option>
            <option value="GET">GET</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ep-url">{t("studio.endpointUrl")}</Label>
          <Input
            id="ep-url"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            className="font-mono text-xs"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ep-status">{t("studio.expectedStatus")}</Label>
          <Input
            id="ep-status"
            type="number"
            min={100}
            max={599}
            value={expectedStatus}
            onChange={(e) => setExpectedStatus(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ep-body">{t("studio.sampleBody")}</Label>
          <Input
            id="ep-body"
            value={sampleBodyJson}
            onChange={(e) => setSampleBodyJson(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        <Button
          type="submit"
          disabled={!name.trim() || !targetUrl.trim() || createEndpoint.isPending}
        >
          <IconPlus className="mr-1.5 size-4" />
          {createEndpoint.isPending
            ? t("studio.addingEndpoint")
            : t("studio.addEndpoint")}
        </Button>
      </form>

      {endpoints.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/50 p-10 text-center">
          <IconBolt className="size-8 text-muted-foreground" />
          <p className="max-w-md text-sm text-muted-foreground">
            {t("studio.emptyEndpoints")}
          </p>
          <Button
            type="button"
            disabled={seed.isPending}
            onClick={() => seed.mutate({})}
          >
            <IconFlask className="mr-1.5 size-4" />
            {t("studio.seedSandbox")}
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 @3xl:grid-cols-2 @6xl:grid-cols-3">
          {endpoints.map((ep) => (
            <EndpointCard
              key={ep.id}
              endpoint={ep}
              runningId={runningEndpointId}
              onDelete={(id) => setPendingDeleteId(id)}
              onRunQuick={(id) => {
                setRunningEndpointId(id);
                runMatrix.mutate({ endpointId: id, triggeredBy: "human" });
              }}
            />
          ))}
        </div>
      )}

      <AlertDialog
        open={Boolean(pendingDeleteId)}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("studio.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("studio.deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("studio.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteEndpoint.isPending}
              onClick={() => {
                if (pendingDeleteId) {
                  deleteEndpoint.mutate({ id: pendingDeleteId });
                }
              }}
            >
              {deleteEndpoint.isPending
                ? t("studio.deleting")
                : t("studio.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
