import { registerTargetSecrets } from "../lib/target-secrets.js";

registerTargetSecrets();

/** Registers ReqLab's target-API credentials with Settings → API keys. */
export default function reqlabSecretsPlugin(): void {
  registerTargetSecrets();
}
