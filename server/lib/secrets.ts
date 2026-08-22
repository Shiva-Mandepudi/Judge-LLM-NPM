import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

// Mirrors Cosmic Guidance's resolveSecretFromEnvOrFile convention
// (server/runtime-security.ts) so the same secret-injection pattern (env var,
// `<NAME>_FILE` mounted file, or GCP Secret Manager resource name) works
// identically across both services.

let smClient: SecretManagerServiceClient | undefined;

async function readSecretManager(resourceName: string): Promise<string> {
  smClient ??= new SecretManagerServiceClient();
  const [version] = await smClient.accessSecretVersion({ name: resourceName });
  const data = version.payload?.data;
  if (!data) throw new Error(`Secret Manager resource ${resourceName} returned no payload`);
  return Buffer.from(data).toString("utf8");
}

/**
 * Resolves a secret reference, in order:
 * 1. `projects/.../secrets/.../versions/...` -> GCP Secret Manager
 * 2. `${NAME}` where `${NAME}_FILE` env var points at a mounted secret file
 * 3. `${NAME}` where `${NAME}` env var holds the value directly (local dev only)
 */
export async function resolveSecret(ref: string): Promise<string> {
  if (ref.startsWith("projects/")) {
    return readSecretManager(ref);
  }
  const filePathVar = `${ref}_FILE`;
  const filePath = process.env[filePathVar];
  if (filePath) {
    const fs = await import("node:fs/promises");
    return (await fs.readFile(filePath, "utf8")).trim();
  }
  const inline = process.env[ref];
  if (inline) return inline;
  throw new Error(`Could not resolve secret reference "${ref}" via Secret Manager, ${filePathVar}, or env var`);
}
