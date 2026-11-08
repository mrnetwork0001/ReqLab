import { sendToAgentChat } from "@agent-native/core/client/agent-chat";
import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
  writeClientAppState,
} from "@agent-native/core/client/hooks";
import { useT } from "@agent-native/core/client/i18n";
import { useAgentSelectable } from "@agent-native/toolkit/app/agent-select";
import { ShareButton } from "@agent-native/toolkit/app/sharing";
import { WaveBackground } from "@agent-native/toolkit/app/shared";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBug,
  IconCheck,
  IconCode,
  IconPlayerPlay,
  IconPlus,
  IconShieldCheck,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
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
import { GuardExportPanel } from "@/components/studio/GuardExportPanel";
import { WebhookInboxPanel } from "@/components/studio/WebhookInboxPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { TAB_ID } from "@/lib/tab-id";

type ScenarioRow = {
  id: string;
  endpointId: string;
  title: string;
  category: string;
  headersJson: string;
  bodyJson: string;
  expectedStatus: number;
  lastHttpCode: number | null;
  lastLatencyMs: number | null;
  lastResponseJson: string | null;
  lastVerdict: string;
  bugSummary: string | null;
  lastRunAt: string | null;
  authoredBy: string;
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

/** Infers a strict-ish Zod guard from a JSON sample body (used for endpoints without a curated guard). */
function inferZodFromSample(value: unknown, indent = ""): string {
  const next = indent + "  ";
  if (typeof value === "string") return "z.string().min(1).max(500)";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value > 0
        ? "z.number().int().positive()"
        : "z.number().int().nonnegative()"
      : "z.number().nonnegative()";
  }
  if (typeof value === "boolean") return "z.boolean()";
  if (value === null) return "z.null()";
  if (Array.isArray(value)) {
    return `z.array(${value.length ? inferZodFromSample(value[0], indent) : "z.unknown()"}).max(100)`;
  }
  if (typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>).map(
      ([key, v]) =>
        `${next}${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${inferZodFromSample(v, next)},`,
    );
    return fields.length ? `z.object({\n${fields.join("\n")}\n${indent}})` : "z.object({})";
  }
  return "z.unknown()";
}

function recommendedGuardFor(endpoint: { targetUrl: string; sampleBodyJson: string }): string {
  const { targetUrl } = endpoint;
  if (targetUrl.startsWith("/sandbox/checkout")) {
    return `z.object({
  sku: z.string().min(1),
  quantity: z.number().int().min(1),
  unitPriceCents: z.number().int().positive(),
  currency: z.enum(["USD", "EUR", "GBP"]).default("USD"),
  couponCode: z.string().optional(),
})`;
  }
  if (targetUrl.startsWith("/sandbox/webhooks/stripe")) {
    return `z.object({
  headers: z.object({
    "x-idempotency-key": z.string().regex(/^idem_[A-Za-z0-9_]+$/),
  }),
  body: z.object({
    eventId: z.string().min(1),
    type: z.string().min(1),
  }),
})`;
  }
  if (targetUrl.startsWith("/sandbox/users")) {
    return `z.object({
  q: z.string().min(1).max(64).regex(/^[a-zA-Z0-9 _@-]+$/),
  limit: z.number().int().min(1).max(100).default(20),
})`;
  }
  try {
    return inferZodFromSample(JSON.parse(endpoint.sampleBodyJson || "{}"));
  } catch {
    return "z.object({})";
  }
}

function VerdictBadge({ verdict, code }: { verdict: string; code: number | null }) {
  if (verdict === "passed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <IconCheck className="size-3.5" />
        {code ? `${code} Passed` : "Passed"}
      </span>
    );
  }
  if (verdict === "bug_exposed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs font-semibold text-rose-600 dark:text-rose-400">
        <IconBug className="size-3.5" />
        {code ? `${code} Bug Exposed` : "500 Bug Exposed"}
      </span>
    );
  }
  if (verdict === "assertion_failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
        <IconAlertTriangle className="size-3.5" />
        {code ? `${code} Mismatch` : "Mismatch"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
      Untested
    </span>
  );
}

function ScenarioMatrixItem({
  scenario,
  selected,
  onSelect,
  onRunOne,
  onDelete,
  runningScenarioId,
}: {
  scenario: ScenarioRow;
  selected: boolean;
  onSelect: () => void;
  onRunOne: () => void;
  onDelete: () => void;
  runningScenarioId: string | null;
}) {
  const t = useT();
  const rowRef = useRef<HTMLDivElement>(null);
  const picked = useAgentSelectable({
    kind: "scenario",
    id: scenario.id,
    title: scenario.title,
    getContext: () =>
      `Scenario id: ${scenario.id} ("${scenario.title}", category=${scenario.category}, verdict=${scenario.lastVerdict}); use update-scenario or run-scenarios`,
    getElement: () => rowRef.current,
  });

  return (
    <div
      ref={rowRef}
      className={`rounded-xl border p-3.5 transition-colors ${
        selected || picked
          ? "border-primary bg-accent/30 ring-1 ring-primary/30"
          : scenario.lastVerdict === "bug_exposed"
            ? "border-rose-500/40 bg-rose-500/5"
            : "border-border bg-card"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-[11px]">
              {scenario.category}
            </Badge>
            <strong className="truncate text-sm font-semibold">
              {scenario.title}
            </strong>
            <span className="text-xs text-muted-foreground">
              · {scenario.authoredBy === "agent" ? "Agent" : "You"}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
            <span>Expect HTTP {scenario.expectedStatus}</span>
            {scenario.lastLatencyMs != null ? (
              <span>{scenario.lastLatencyMs}ms</span>
            ) : null}
            <span className="max-w-xs truncate">{scenario.bodyJson}</span>
          </div>
        </button>

        <div className="flex items-center gap-1.5">
          <VerdictBadge
            verdict={scenario.lastVerdict}
            code={scenario.lastHttpCode}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={runningScenarioId === scenario.id}
            onClick={onRunOne}
          >
            <IconPlayerPlay className="mr-1 size-3" />
            {t("studio.runScenario")}
          </Button>
          {!scenario.id.startsWith("pending-") ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t("studio.confirmDelete")}
              onClick={onDelete}
            >
              <IconTrash className="size-3.5 text-muted-foreground" />
            </Button>
          ) : null}
        </div>
      </div>

      {scenario.bugSummary ? (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          <IconBug className="mt-0.5 size-3.5 shrink-0" />
          <span>{scenario.bugSummary}</span>
        </div>
      ) : null}
    </div>
  );
}

export default function StudioEndpointDetailRoute() {
  const t = useT();
  const { endpointId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const params = useMemo(() => ({ id: endpointId }), [endpointId]);
  const queryKey = ["action", "get-endpoint", params];
  const { data, isPending } = useActionQuery("get-endpoint", params);

  const [newTitle, setNewTitle] = useState("");
  const [newCategory, setNewCategory] = useState<
    "baseline" | "boundary" | "injection" | "auth" | "idempotency" | "schema-fuzz"
  >("boundary");
  const [newExpectedStatus, setNewExpectedStatus] = useState("422");
  const [newBodyJson, setNewBodyJson] = useState(
    '{"sku":"pro-seat-annual","quantity":-1,"unitPriceCents":4900}',
  );

  const [editTitle, setEditTitle] = useState("");
  const [editExpectedStatus, setEditExpectedStatus] = useState("200");
  const [editHeadersJson, setEditHeadersJson] = useState("{}");
  const [editBodyJson, setEditBodyJson] = useState("{}");
  const [contractText, setContractText] = useState("");
  const [pendingDeleteScenarioId, setPendingDeleteScenarioId] = useState<
    string | null
  >(null);
  const [runningScenarioId, setRunningScenarioId] = useState<string | null>(
    null,
  );

  const endpoint = data?.endpoint;
  const scenarios = data?.scenarios ?? [];
  const runs = data?.runs ?? [];

  const selectedScenarioId =
    searchParams.get("scenarioId") ?? scenarios[0]?.id ?? "";
  const selectedScenario =
    scenarios.find((s) => s.id === selectedScenarioId) ?? scenarios[0];

  useEffect(() => {
    if (endpoint) {
      setContractText(endpoint.contractZodSchema);
    }
  }, [endpoint?.id, endpoint?.contractZodSchema]);

  useEffect(() => {
    if (selectedScenario) {
      setEditTitle(selectedScenario.title);
      setEditExpectedStatus(String(selectedScenario.expectedStatus));
      setEditHeadersJson(selectedScenario.headersJson);
      setEditBodyJson(selectedScenario.bodyJson);
      void writeClientAppState(
        `selection:${TAB_ID}`,
        {
          kind: "scenario",
          id: selectedScenario.id,
          endpointId,
          title: selectedScenario.title,
          verdict: selectedScenario.lastVerdict,
        },
        { requestSource: TAB_ID },
      );
    }
  }, [selectedScenario?.id, endpointId]);

  const runScenarios = useActionMutation("run-scenarios", {
    onSettled: () => setRunningScenarioId(null),
    onSuccess: (res) => {
      if (res.bugsExposedCount > 0) {
        toast.error(
          `${res.bugsExposedCount} unhandled 500 crash(es) exposed! Inspect the red rows or apply a Zod Contract Guard.`,
        );
      } else {
        toast.success(
          res.assertionFailedCount > 0
            ? `${res.assertionFailedCount} contract mismatch(es): the API returned an unexpected status. Inspect the amber rows or apply a Zod Contract Guard.`
            : `${res.passedCount}/${res.totalExecuted} scenarios passed!`,
        );
      }
    },
    onError: (error) => {
      toast.error(actionErrorMessage(error) ?? t("studio.createFailed"));
    },
  });

  const createScenario = useActionMutation("create-scenario", {
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(
        queryKey,
        (
          old:
            | {
                endpoint: NonNullable<typeof endpoint>;
                scenarios: ScenarioRow[];
                runs: typeof runs;
              }
            | undefined,
        ) =>
          old && {
            ...old,
            scenarios: [
              ...old.scenarios,
              {
                id: "pending-" + Date.now(),
                endpointId: input.endpointId,
                title: input.title,
                category: input.category ?? "boundary",
                headersJson: input.headersJson ?? "{}",
                bodyJson: input.bodyJson ?? "{}",
                expectedStatus: input.expectedStatus ?? 422,
                lastHttpCode: null,
                lastLatencyMs: null,
                lastResponseJson: null,
                lastVerdict: "untested",
                bugSummary: null,
                lastRunAt: null,
                authoredBy: "human",
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
        errorCode(error) === "scenario_conflict"
          ? t("studio.scenarioConflict")
          : (actionErrorMessage(error) ?? t("studio.createFailed")),
      );
    },
    onSuccess: (created) => {
      setNewTitle("");
      setSearchParams({ scenarioId: created.id });
      toast.success(t("studio.scenarioCreated"));
    },
  });

  const updateScenario = useActionMutation("update-scenario", {
    onSuccess: () => {
      toast.success(t("studio.scenarioUpdated"));
    },
    onError: (error) => {
      toast.error(actionErrorMessage(error) ?? t("studio.createFailed"));
    },
  });

  const deleteScenario = useActionMutation("delete-scenario", {
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(
        queryKey,
        (
          old:
            | {
                endpoint: NonNullable<typeof endpoint>;
                scenarios: ScenarioRow[];
                runs: typeof runs;
              }
            | undefined,
        ) =>
          old && {
            ...old,
            scenarios: old.scenarios.filter((s) => s.id !== id),
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
    onSuccess: () => setPendingDeleteScenarioId(null),
  });

  const updateEndpoint = useActionMutation("update-endpoint", {
    onSuccess: () => {
      toast.success(t("studio.contractSaved"));
    },
    onError: (error) => {
      toast.error(actionErrorMessage(error) ?? t("studio.createFailed"));
    },
  });

  function handleAddScenario(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newTitle.trim()) return;
    createScenario.mutate({
      endpointId,
      title: newTitle.trim(),
      category: newCategory,
      expectedStatus: Number(newExpectedStatus) || 422,
      bodyJson: newBodyJson.trim() || "{}",
      headersJson: "{}",
      authoredBy: "human",
    });
  }

  function handleApplyRecommendedGuardAndRun() {
    if (!endpoint) return;
    const recommended = recommendedGuardFor(endpoint);
    setContractText(recommended);
    updateEndpoint.mutate(
      {
        id: endpoint.id,
        contractZodSchema: recommended,
        revisedBy: "human",
      },
      {
        onSuccess: () => {
          runScenarios.mutate({
            endpointId: endpoint.id,
            triggeredBy: "human",
          });
        },
      },
    );
  }

  function handleAskAgentFuzz() {
    if (!endpoint) return;
    sendToAgentChat({
      openSidebar: true,
      submit: true,
      message: `Generate 2 new adversarial chaos scenarios for endpoint "${endpoint.name}" (endpointId: ${endpoint.id}, URL: ${endpoint.targetUrl}) using create-scenario, then execute the full matrix with run-scenarios.`,
    });
  }

  function handleBugHunt() {
    if (!endpoint) return;
    const guarded = Boolean(endpoint.contractZodSchema.trim());
    sendToAgentChat({
      openSidebar: true,
      submit: true,
      message: [
        `Start a BUG HUNT on "${endpoint.name}" (endpointId: ${endpoint.id}, ${endpoint.method} ${endpoint.targetUrl}).`,
        "Goal: find a real server crash (a 5xx) or an input the API wrongly accepts.",
        "Loop, narrating each round in one short line before you call the tool:",
        "1. Call attack-batch with 5-6 adversarial attacks this round (round:1, then 2, 3...). Vary categories: boundary values, type confusion, injection, auth, idempotency/replay, malformed/oversized bodies. For each attack set expectedStatus to what a CORRECT API should return (usually a 4xx for bad input).",
        "2. Read the returned results. verdict bug_exposed = a real 5xx crash; assertion_failed = wrong status (e.g. it accepted bad input). Use each responseExcerpt and bugSummary to design a SHARPER next batch focused on whatever leaked a stack trace, accepted bad input, or behaved oddly.",
        "3. Stop as soon as you expose a crash (or after 4 rounds). Then explain the root cause from the real error" + (guarded ? "." : ", write a Zod contract guard with update-endpoint that rejects it without breaking the baseline, re-run, and offer to export it as middleware with export-contract-guard."),
        "Keep each attack body realistic for THIS endpoint based on its existing scenarios and sample body.",
      ].join("\n"),
    });
  }

  function handleAskAgentFixBugs() {
    if (!endpoint) return;
    const failing = scenarios
      .filter((s) => s.lastVerdict === "bug_exposed" || s.lastVerdict === "assertion_failed")
      .map((s) => `"${s.title}" (${s.bugSummary ?? "unexpected response"})`)
      .join("; ");
    sendToAgentChat({
      openSidebar: true,
      submit: true,
      message: `Endpoint "${endpoint.name}" (endpointId: ${endpoint.id}, ${endpoint.method} ${endpoint.targetUrl}) is failing on: ${failing || "adversarial inputs"}. Use get-endpoint to read each failing scenario's payload and response, diagnose the root cause from the real error, then write a Zod contract guard with update-endpoint (contractZodSchema) that rejects those inputs while still accepting the baseline scenarios. Run run-scenarios to verify; if a baseline scenario starts failing, loosen the guard and re-run.`,
    });
  }

  if (isPending) {
    return (
      <div className="@container grid gap-4 p-4 sm:p-6 @5xl:grid-cols-12">
        <Skeleton className="h-96 rounded-xl @5xl:col-span-7" />
        <Skeleton className="h-96 rounded-xl @5xl:col-span-5" />
      </div>
    );
  }

  if (!endpoint) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          {t("studio.endpointNotFound")}
        </p>
        <Link className="mt-3 inline-block text-sm underline" to="/studio">
          {t("studio.backToStudio")}
        </Link>
      </div>
    );
  }

  const bugsExposedCount = scenarios.filter(
    (s) => s.lastVerdict === "bug_exposed",
  ).length;
  const failingCount = scenarios.filter(
    (s) => s.lastVerdict === "bug_exposed" || s.lastVerdict === "assertion_failed",
  ).length;

  return (
    <div className="@container flex min-h-full flex-col gap-4 p-4 sm:p-6">
      <div className="relative isolate flex flex-wrap items-center justify-between gap-3 overflow-hidden rounded-2xl border border-border p-4">
        <WaveBackground
          matchPageSurface
          className="pointer-events-none absolute inset-0 -z-10 opacity-40"
        />
        <div className="min-w-0 space-y-1">
          <Link
            to="/studio"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <IconArrowLeft className="size-3.5" />
            {t("studio.backToStudio")}
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              {endpoint.method}
            </Badge>
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {endpoint.name}
            </h1>
            <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
              {endpoint.targetUrl}
            </code>
            <Badge variant="outline" className="font-mono text-xs">
              v{endpoint.revisionCount} ·{" "}
              {endpoint.lastRevisedBy === "agent"
                ? t("studio.revisedByAgent")
                : t("studio.revisedByHuman")}
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={runScenarios.isPending}
            onClick={() =>
              runScenarios.mutate({
                endpointId: endpoint.id,
                triggeredBy: "human",
              })
            }
          >
            <IconPlayerPlay className="mr-1.5 size-4" />
            {runScenarios.isPending
              ? t("studio.runningScenarios")
              : t("studio.runAllScenarios")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleBugHunt}
            title="The agent attacks this endpoint in adaptive rounds until it finds a crash"
          >
            <IconBug className="mr-1.5 size-4" />
            {t("studio.bugHunt")}
          </Button>
          {bugsExposedCount > 0 ? (
            <Button
              type="button"
              variant="secondary"
              onClick={handleAskAgentFixBugs}
            >
              <IconSparkles className="mr-1.5 size-4" />
              {t("studio.askAgentFixBugs")} ({bugsExposedCount})
            </Button>
          ) : failingCount > 0 ? (
            <Button
              type="button"
              variant="secondary"
              onClick={handleAskAgentFixBugs}
            >
              <IconSparkles className="mr-1.5 size-4" />
              {t("studio.askAgentFixFailures")} ({failingCount})
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={handleAskAgentFuzz}
          >
            <IconSparkles className="mr-1.5 size-4" />
            {t("studio.askAgentFuzz")}
          </Button>
          <ShareButton
            resourceType="endpoint"
            resourceId={endpoint.id}
            resourceTitle={endpoint.name}
          />
        </div>
      </div>

      <div className="grid min-h-0 gap-5 @5xl:grid-cols-12">
        {/* Left Column: Chaos & Edge-Case Matrix + Add Scenario Form */}
        <div className="flex flex-col gap-4 @5xl:col-span-7">
          <form
            onSubmit={handleAddScenario}
            className="grid gap-3 rounded-xl border border-border bg-card p-3.5 @2xl:grid-cols-[minmax(9rem,1.2fr)_8rem_5.5rem_minmax(10rem,1.4fr)_auto] @2xl:items-end"
          >
            <div className="space-y-1">
              <Label htmlFor="sc-title">{t("studio.scenarioTitle")}</Label>
              <Input
                id="sc-title"
                placeholder="Zero Quantity Boundary"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sc-cat">{t("studio.scenarioCategory")}</Label>
              <select
                id="sc-cat"
                value={newCategory}
                onChange={(e) =>
                  setNewCategory(
                    e.target.value as
                      | "baseline"
                      | "boundary"
                      | "injection"
                      | "auth"
                      | "idempotency"
                      | "schema-fuzz",
                  )
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                <option value="baseline">baseline</option>
                <option value="boundary">boundary</option>
                <option value="schema-fuzz">schema-fuzz</option>
                <option value="injection">injection</option>
                <option value="auth">auth</option>
                <option value="idempotency">idempotency</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sc-exp">{t("studio.expectedStatus")}</Label>
              <Input
                id="sc-exp"
                type="number"
                min={100}
                max={599}
                value={newExpectedStatus}
                onChange={(e) => setNewExpectedStatus(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sc-body">{t("studio.scenarioPayload")}</Label>
              <Input
                id="sc-body"
                value={newBodyJson}
                onChange={(e) => setNewBodyJson(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <Button
              type="submit"
              size="sm"
              className="h-9"
              disabled={!newTitle.trim() || createScenario.isPending}
            >
              <IconPlus className="mr-1 size-3.5" />
              {createScenario.isPending
                ? t("studio.addingScenario")
                : t("studio.addScenario")}
            </Button>
          </form>

          <div className="space-y-2.5">
            {scenarios.map((scenario) => (
              <ScenarioMatrixItem
                key={scenario.id}
                scenario={scenario}
                selected={selectedScenario?.id === scenario.id}
                runningScenarioId={runningScenarioId}
                onSelect={() => setSearchParams({ scenarioId: scenario.id })}
                onRunOne={() => {
                  setRunningScenarioId(scenario.id);
                  runScenarios.mutate({
                    endpointId: endpoint.id,
                    scenarioId: scenario.id,
                    triggeredBy: "human",
                  });
                }}
                onDelete={() => setPendingDeleteScenarioId(scenario.id)}
              />
            ))}
          </div>
        </div>

        {/* Right Column: Live Scenario Payload Editor, Contract Guard & Run History */}
        <div className="flex flex-col gap-4 @5xl:col-span-5">
          {selectedScenario ? (
            <section className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-sm font-semibold">
                  {selectedScenario.title}
                </strong>
                <VerdictBadge
                  verdict={selectedScenario.lastVerdict}
                  code={selectedScenario.lastHttpCode}
                />
              </div>

              <div className="grid gap-2.5 sm:grid-cols-[1fr_6.5rem]">
                <div className="space-y-1">
                  <Label htmlFor="edit-sc-title">
                    {t("studio.scenarioTitle")}
                  </Label>
                  <Input
                    id="edit-sc-title"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="edit-sc-exp">
                    {t("studio.expectedStatus")}
                  </Label>
                  <Input
                    id="edit-sc-exp"
                    type="number"
                    min={100}
                    max={599}
                    value={editExpectedStatus}
                    onChange={(e) => setEditExpectedStatus(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="edit-sc-headers">
                  Request Headers (JSON, overrides endpoint defaults)
                </Label>
                <Textarea
                  id="edit-sc-headers"
                  rows={2}
                  value={editHeadersJson}
                  onChange={(e) => setEditHeadersJson(e.target.value)}
                  placeholder='{ "authorization": "Bearer {{secret:REQLAB_TARGET_API_KEY}}" }'
                  className="font-mono text-xs"
                />
                <p className="text-[11px] text-muted-foreground">
                  Keep real tokens out of scenarios: reference{" "}
                  <code>{"{{secret:REQLAB_TARGET_API_KEY}}"}</code> and set the
                  value in Settings → API keys. It is resolved only at run time
                  and redacted from responses.
                </p>
              </div>

              <div className="space-y-1">
                <Label htmlFor="edit-sc-body">
                  {t("studio.scenarioPayload")}
                </Label>
                <Textarea
                  id="edit-sc-body"
                  rows={4}
                  value={editBodyJson}
                  onChange={(e) => setEditBodyJson(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={updateScenario.isPending}
                  onClick={() =>
                    updateScenario.mutate({
                      id: selectedScenario.id,
                      title: editTitle.trim() || selectedScenario.title,
                      expectedStatus:
                        Number(editExpectedStatus) ||
                        selectedScenario.expectedStatus,
                      headersJson: editHeadersJson,
                      bodyJson: editBodyJson,
                      authoredBy: "human",
                    })
                  }
                >
                  Save Scenario
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={runScenarios.isPending}
                  onClick={() =>
                    updateScenario.mutate(
                      {
                        id: selectedScenario.id,
                        title: editTitle.trim() || selectedScenario.title,
                        expectedStatus:
                          Number(editExpectedStatus) ||
                          selectedScenario.expectedStatus,
                        headersJson: editHeadersJson,
                        bodyJson: editBodyJson,
                        authoredBy: "human",
                      },
                      {
                        onSuccess: () => {
                          runScenarios.mutate({
                            endpointId: endpoint.id,
                            scenarioId: selectedScenario.id,
                            triggeredBy: "human",
                          });
                        },
                      },
                    )
                  }
                >
                  <IconPlayerPlay className="mr-1.5 size-3.5" />
                  Save & Re-Run
                </Button>
              </div>

              {selectedScenario.lastResponseJson ? (
                <div className="space-y-1 pt-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Live Response ({selectedScenario.lastHttpCode ? `HTTP ${selectedScenario.lastHttpCode}` : "No HTTP response"} ·{" "}
                    {selectedScenario.lastLatencyMs}ms)
                  </span>
                  <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-xs">
                    {selectedScenario.lastResponseJson}
                  </pre>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <IconShieldCheck className="size-4 text-emerald-500" />
                <strong className="text-sm font-semibold">
                  Zod Contract Guard
                </strong>
              </div>
              <Badge variant="outline" className="text-xs">
                {contractText.trim()
                  ? t("studio.contractGuarded")
                  : t("studio.unguarded")}
              </Badge>
            </div>

            <Textarea
              rows={5}
              placeholder="z.object({ quantity: z.number().int().min(1) })"
              value={contractText}
              onChange={(e) => setContractText(e.target.value)}
              className="font-mono text-xs"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={updateEndpoint.isPending}
                onClick={() =>
                  updateEndpoint.mutate({
                    id: endpoint.id,
                    contractZodSchema: contractText,
                    revisedBy: "human",
                  })
                }
              >
                <IconCode className="mr-1.5 size-3.5" />
                {t("studio.saveContract")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={updateEndpoint.isPending || runScenarios.isPending}
                onClick={handleApplyRecommendedGuardAndRun}
              >
                <IconShieldCheck className="mr-1.5 size-3.5" />
                {t("studio.applyRecommendedGuard")}
              </Button>
              <GuardExportPanel
                key={endpoint.contractZodSchema}
                endpointId={endpoint.id}
                hasSavedGuard={Boolean(endpoint.contractZodSchema.trim())}
              />
            </div>
          </section>

          <WebhookInboxPanel
            endpointId={endpoint.id}
            existingTitles={scenarios.map((scenario) => scenario.title)}
          />

          {runs.length > 0 ? (
            <section className="space-y-2 rounded-xl border border-border bg-card p-4">
              <strong className="block text-sm font-semibold">
                Recent Execution Audit Trail
              </strong>
              <div className="max-h-48 space-y-1.5 overflow-y-auto">
                {runs.slice(0, 8).map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs"
                  >
                    <span className="truncate font-medium">
                      {run.scenarioTitle}
                    </span>
                    <div className="flex shrink-0 items-center gap-2 font-mono">
                      <span>{run.httpCode}</span>
                      <span className="text-muted-foreground">
                        {run.latencyMs}ms
                      </span>
                      <span className="text-muted-foreground">
                        {run.triggeredBy}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <AlertDialog
        open={Boolean(pendingDeleteScenarioId)}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteScenarioId(null);
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
              disabled={deleteScenario.isPending}
              onClick={() => {
                if (pendingDeleteScenarioId) {
                  deleteScenario.mutate({ id: pendingDeleteScenarioId });
                }
              }}
            >
              {deleteScenario.isPending
                ? t("studio.deleting")
                : t("studio.confirmDelete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
