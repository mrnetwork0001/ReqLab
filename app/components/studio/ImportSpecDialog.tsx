import {
  actionErrorMessage,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import { IconDownload, IconFileImport } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const EXAMPLES = [
  { label: "Swagger Petstore", url: "https://petstore3.swagger.io/api/v3/openapi.json" },
];

/** Paste an OpenAPI/Swagger URL and ReqLab imports every operation as an endpoint. */
export function ImportSpecDialog({ label }: { label: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [specUrl, setSpecUrl] = useState("");

  const importSpec = useActionMutation("import-openapi", {
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["action", "list-endpoints"] });
      toast.success(
        `Imported ${result.createdEndpoints} endpoint${result.createdEndpoints === 1 ? "" : "s"} and ${result.createdScenarios} scenarios from ${result.apiTitle}` +
          (result.skippedEndpoints ? ` (${result.skippedEndpoints} already existed)` : ""),
      );
      setOpen(false);
      setSpecUrl("");
      if (result.endpoints[0]) navigate(`/studio/${result.endpoints[0].id}`);
    },
    onError: (error) => toast.error(actionErrorMessage(error) ?? "Could not import the spec."),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <IconFileImport className="mr-1.5 size-4" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import an OpenAPI spec</DialogTitle>
          <DialogDescription>
            Paste the URL of an OpenAPI 3.x or Swagger 2.0 document. ReqLab
            creates one endpoint per operation, each with a baseline request and
            adversarial attack scenarios derived from its schema.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="spec-url">Spec URL</Label>
          <Input
            id="spec-url"
            placeholder="https://api.example.com/openapi.json"
            value={specUrl}
            onChange={(e) => setSpecUrl(e.target.value)}
            className="font-mono text-xs"
          />
          <div className="flex flex-wrap gap-1.5 pt-1">
            {EXAMPLES.map((example) => (
              <button
                key={example.url}
                type="button"
                onClick={() => setSpecUrl(example.url)}
                className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                {example.label}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={!specUrl.trim() || importSpec.isPending}
            onClick={() => importSpec.mutate({ specUrl: specUrl.trim(), limit: 12, seedAttacks: true })}
          >
            <IconDownload className="mr-1.5 size-4" />
            {importSpec.isPending ? "Importing…" : "Import & seed attacks"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
