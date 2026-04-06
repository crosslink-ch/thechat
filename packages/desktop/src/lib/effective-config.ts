import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, WorkspaceConfig } from "@thechat/shared";
import { api } from "./api";
import { useAuthStore } from "../stores/auth";

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

/**
 * Result of resolving the effective config.
 */
export interface EffectiveConfig {
  config: AppConfig;
}

/** Cache workspace config for a short period to avoid re-fetching on every message. */
let wsConfigCache: { id: string; config: WorkspaceConfig; ts: number } | null = null;
const CACHE_TTL = 30_000; // 30 seconds

async function fetchWorkspaceConfig(
  workspaceId: string,
  token: string,
): Promise<WorkspaceConfig | null> {
  // Return cached if fresh
  if (wsConfigCache && wsConfigCache.id === workspaceId && Date.now() - wsConfigCache.ts < CACHE_TTL) {
    return wsConfigCache.config;
  }

  try {
    const { data, error } = await api.workspaces({ id: workspaceId }).config.get(auth(token));
    if (error) return null;
    const cfg = data as WorkspaceConfig;
    wsConfigCache = { id: workspaceId, config: cfg, ts: Date.now() };
    return cfg;
  } catch {
    return null;
  }
}

/** Invalidate the workspace config cache (call after saving workspace config). */
export function invalidateWorkspaceConfigCache(): void {
  wsConfigCache = null;
}

/**
 * Load the local config and merge with workspace config based on inheritance settings.
 * Returns the effective config to use for chat operations.
 */
export async function getEffectiveConfig(): Promise<EffectiveConfig> {
  const localConfig = await invoke<AppConfig>("get_config");

  if (!localConfig.inheritWorkspaceId) {
    return { config: localConfig };
  }

  const token = useAuthStore.getState().token;
  if (!token) {
    return { config: localConfig };
  }

  const wsConfig = await fetchWorkspaceConfig(localConfig.inheritWorkspaceId, token);
  if (!wsConfig) {
    return { config: localConfig };
  }

  const overrides = localConfig.localOverrides ?? {};
  const effective = { ...localConfig };

  // Merge provider
  if (!overrides.provider && wsConfig.provider) {
    effective.provider = wsConfig.provider;
  }

  // Merge OpenRouter API key
  if (!overrides.apiKey && wsConfig.openrouter?.apiKey) {
    effective.api_key = wsConfig.openrouter.apiKey;
  }

  // Merge models
  effective.providers = { ...effective.providers };
  if (!overrides.openrouterModel && wsConfig.openrouterModel) {
    effective.providers.openrouter = { ...effective.providers.openrouter, model: wsConfig.openrouterModel };
  }
  if (!overrides.codexModel && wsConfig.codexModel) {
    effective.providers.codex = { ...effective.providers.codex, model: wsConfig.codexModel };
  }

  // Merge reasoning effort
  if (!overrides.reasoningEffort && wsConfig.reasoningEffort) {
    effective.reasoningEffort = wsConfig.reasoningEffort;
  }

  return { config: effective };
}
