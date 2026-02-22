import type { CredentialInfo, CredentialValue } from "@thechat/shared";
import { useAuthStore } from "../stores/auth";

interface CredentialDefinition extends CredentialInfo {
  resolve: () => Promise<string>;
}

const registry = new Map<string, CredentialDefinition>();

export function registerCredential(def: CredentialDefinition): void {
  registry.set(def.name, def);
}

export function listCredentials(): CredentialInfo[] {
  return Array.from(registry.values()).map(({ name, description, type }) => ({
    name,
    description,
    type,
  }));
}

export async function resolveCredential(name: string): Promise<CredentialValue> {
  const def = registry.get(name);
  if (!def) {
    throw new Error(`Unknown credential: ${name}`);
  }
  const value = await def.resolve();
  return { credential_name: def.name, type: def.type, value };
}

// -- Built-in credentials --

registerCredential({
  name: "thechat_api_token",
  description:
    "Access token for TheChat backend API. Use as a Bearer token for authenticated requests.",
  type: "bearer",
  resolve: async () => {
    const token = useAuthStore.getState().token;
    if (!token) {
      throw new Error("Not logged in — no API token available");
    }
    return token;
  },
});
