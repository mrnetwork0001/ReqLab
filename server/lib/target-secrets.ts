/**
 * Credentials for target APIs.
 *
 * Endpoint and scenario headers may reference a secret instead of embedding a
 * token: `{"authorization": "Bearer {{secret:REQLAB_TARGET_API_KEY}}"}`. The
 * value lives in the framework's secrets store (Settings → API keys), is
 * resolved server-side only when a scenario runs, and is redacted from stored
 * responses. Only the ReqLab keys registered below can be referenced, so a
 * header can never pull another app credential (for example an LLM key) and
 * send it to an arbitrary URL.
 */
import { registerRequiredSecret } from "@agent-native/core/secrets";

export const TARGET_SECRET_KEYS = [
  "REQLAB_TARGET_API_KEY",
  "REQLAB_TARGET_API_KEY_2",
  "REQLAB_WEBHOOK_SIGNING_SECRET",
] as const;

export type TargetSecretKey = (typeof TARGET_SECRET_KEYS)[number];

const PLACEHOLDER = /\{\{\s*secret:([A-Za-z0-9_]+)\s*\}\}/g;

let registered = false;

/** Registers the target-API keys with the shared Settings → API keys surface. */
export function registerTargetSecrets(): void {
  if (registered) return;
  registered = true;
  const usage = [
    {
      feature: "ReqLab scenario runs",
      effectWhenRemoved:
        "Scenarios whose headers reference this key stop running until it is set again.",
    },
  ];
  registerRequiredSecret({
    key: "REQLAB_TARGET_API_KEY",
    label: "Target API key (primary)",
    description:
      'Token for the API under test. Reference it in endpoint or scenario headers as {{secret:REQLAB_TARGET_API_KEY}}, e.g. "authorization": "Bearer {{secret:REQLAB_TARGET_API_KEY}}".',
    scope: "user",
    kind: "api-key",
    required: false,
    usedFor: usage,
  });
  registerRequiredSecret({
    key: "REQLAB_TARGET_API_KEY_2",
    label: "Target API key (secondary)",
    description:
      "A second token, e.g. for a second environment or a low-privilege account in auth scenarios. Reference it as {{secret:REQLAB_TARGET_API_KEY_2}}.",
    scope: "user",
    kind: "api-key",
    required: false,
    usedFor: usage,
  });
  registerRequiredSecret({
    key: "REQLAB_WEBHOOK_SIGNING_SECRET",
    label: "Webhook signing secret",
    description:
      "Signing secret or shared token for a webhook receiver under test. Reference it as {{secret:REQLAB_WEBHOOK_SIGNING_SECRET}}.",
    scope: "user",
    kind: "api-key",
    required: false,
    usedFor: usage,
  });
}

/** Secret keys referenced by any of the given header JSON strings. */
export function findSecretReferences(...headerSources: string[]): string[] {
  const keys = new Set<string>();
  for (const source of headerSources) {
    for (const match of (source ?? "").matchAll(PLACEHOLDER)) {
      if (match[1]) keys.add(match[1]);
    }
  }
  return [...keys];
}

export function isTargetSecretKey(key: string): key is TargetSecretKey {
  return (TARGET_SECRET_KEYS as readonly string[]).includes(key);
}

/** Replaces `{{secret:KEY}}` placeholders with resolved values. Unknown keys are left as-is. */
export function substituteSecrets(value: string, secrets: Record<string, string>): string {
  return value.replace(PLACEHOLDER, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(secrets, key) ? (secrets[key] ?? whole) : whole,
  );
}

/** Removes every resolved secret value from text that will be stored or shown. */
export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(secrets)) {
    if (value && value.length >= 4) out = out.split(value).join(`[redacted:${key}]`);
  }
  return out;
}
