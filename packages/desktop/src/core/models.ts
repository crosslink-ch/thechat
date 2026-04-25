/**
 * Centralized model registry with per-model output token limits.
 *
 * When making API requests, the effective max_tokens is:
 *   Math.min(model.maxOutputTokens, OUTPUT_TOKEN_MAX)
 *
 * This prevents truncated responses (stop_reason "length") while
 * respecting both model capabilities and a global ceiling.
 */

import { debug as logDebug, warn as logWarn } from "../log";

/** Global ceiling for output tokens across all models. */
export const OUTPUT_TOKEN_MAX = 32_768;

/** Default reasoning effort used across all providers ("xhigh" enables extra-high reasoning depth). */
export const DEFAULT_REASONING_EFFORT = "xhigh";

export interface ModelInfo {
  id: string;
  name: string;
  maxOutputTokens: number;
  contextWindow: number;
  /** Explicit input token limit, if stricter than contextWindow - maxOutputTokens. */
  inputLimit?: number;
}

// ---------------------------------------------------------------------------
// Codex (OpenAI) models
// ---------------------------------------------------------------------------

export const CODEX_MODELS: ModelInfo[] = [
  { id: "gpt-5.5", name: "GPT-5.5", maxOutputTokens: 128_000, contextWindow: 272_000, inputLimit: 144_000 },
  { id: "gpt-5.4", name: "GPT-5.4", maxOutputTokens: 128_000, contextWindow: 1_050_000, inputLimit: 922_000 },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", maxOutputTokens: 128_000, contextWindow: 400_000, inputLimit: 272_000 },
];

// ---------------------------------------------------------------------------
// GLM (Z.ai) models
// ---------------------------------------------------------------------------

export const GLM_MODELS: ModelInfo[] = [
  { id: "glm-5.1", name: "GLM-5.1", maxOutputTokens: 131_072, contextWindow: 128_000 },
  { id: "glm-5-turbo", name: "GLM-5 Turbo", maxOutputTokens: 16_384, contextWindow: 128_000 },
  { id: "glm-4.7", name: "GLM-4.7", maxOutputTokens: 16_384, contextWindow: 128_000 },
  { id: "glm-4.5-air", name: "GLM-4.5 Air", maxOutputTokens: 16_384, contextWindow: 128_000 },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Hardcoded models only — used for UI dropdowns (settings page). */
const MODEL_INDEX = new Map<string, ModelInfo>();
for (const m of [...CODEX_MODELS, ...GLM_MODELS]) {
  MODEL_INDEX.set(m.id, m);
}

/**
 * Get the full model info for a known model, or undefined for unknown models.
 *
 * Lookup order:
 *   1. Exact match in hardcoded models (MODEL_INDEX) — includes previously
 *      promoted registry models, so repeated lookups are instant.
 *   2. For prefixed IDs like "anthropic/claude-sonnet-4-6", try stripping the
 *      provider prefix so OpenRouter model IDs find hardcoded entries
 *   3. On-demand lookup from the models.dev localStorage cache (parses JSON,
 *      promotes the single model into MODEL_INDEX, discards the rest).
 *      If no cache exists, fetches from models.dev first.
 */
export async function getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
  const hardcoded = MODEL_INDEX.get(modelId);
  if (hardcoded) return hardcoded;

  // Prefix-stripping fallback: "provider/model" → "model"
  const slashIdx = modelId.indexOf("/");
  if (slashIdx !== -1) {
    const stripped = MODEL_INDEX.get(modelId.slice(slashIdx + 1));
    if (stripped) return stripped;
  }

  // Fall through to external registry (on-demand from localStorage cache)
  return lookupRegistryModel(modelId);
}

/**
 * Get the effective max output tokens for a model, capped by OUTPUT_TOKEN_MAX.
 * Falls back to OUTPUT_TOKEN_MAX if the model is unknown.
 */
export async function getMaxOutputTokens(modelId: string): Promise<number> {
  const info = await getModelInfo(modelId);
  if (!info) return OUTPUT_TOKEN_MAX;
  return Math.min(info.maxOutputTokens, OUTPUT_TOKEN_MAX);
}

// ---------------------------------------------------------------------------
// External model registry (models.dev fallback)
// ---------------------------------------------------------------------------
// MODEL_INDEX only contains hardcoded models. When getModelInfo misses, we
// look up the model from a localStorage cache (populated from models.dev).
// Only the requested model is promoted into MODEL_INDEX — the full parsed
// JSON is discarded immediately. If localStorage is empty, we fetch from
// models.dev on demand.

const REGISTRY_URL = "https://models.dev/api.json";
const REGISTRY_CACHE_KEY = "thechat:models-registry";
const REGISTRY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

/** Compact cache format: { ts: timestamp, m: { modelId: [contextWindow, maxOutput, name] } } */
interface RegistryCache {
  ts: number;
  m: Record<string, [context: number, output: number, name: string]>;
}

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

/**
 * Parse the models.dev API response into our compact cache format.
 *
 * models.dev structure: `{ providerName: { id, models: { modelId: { id, name, limit: { context, output } } } } }`
 *
 * For each model we store entries keyed by:
 *   - The original model ID (e.g. "gpt-4.1")
 *   - provider/model (e.g. "openai/gpt-4.1") — matches OpenRouter's ID format
 */
function parseModelsDevResponse(data: unknown): RegistryCache["m"] {
  const entries: RegistryCache["m"] = {};

  for (const provider of Object.values(data as Record<string, any>)) {
    const providerId: string | undefined = provider?.id;
    if (!provider?.models || typeof provider.models !== "object") continue;

    for (const model of Object.values(provider.models) as any[]) {
      const modelId: string | undefined = model?.id;
      if (!modelId || !model?.limit) continue;
      const context: unknown = model.limit.context;
      if (typeof context !== "number") continue;
      const output = typeof model.limit.output === "number" ? model.limit.output : OUTPUT_TOKEN_MAX;
      const name: string = model.name || modelId;

      entries[modelId] = [context, output, name];

      // Also store as "provider/model" for OpenRouter-style lookups
      if (providerId && !modelId.includes("/")) {
        entries[`${providerId}/${modelId}`] = [context, output, name];
      }
    }
  }

  return entries;
}

/** In-flight fetch promise to avoid duplicate network requests. */
let fetchPromise: Promise<void> | null = null;

/**
 * Fetch models.dev/api.json and persist to localStorage.
 * Deduplicates concurrent calls. The returned promise resolves once the
 * cache is written (or on error).
 */
export function refreshRegistryCache(): Promise<void> {
  if (fetchPromise) return fetchPromise;
  fetchPromise = (async () => {
    if (!hasLocalStorage()) {
      logDebug("[models] localStorage unavailable, skipping registry refresh");
      return;
    }
    if (typeof fetch === "undefined") {
      logDebug("[models] fetch unavailable, skipping registry refresh");
      return;
    }
    try {
      const resp = await fetch(REGISTRY_URL);
      if (!resp.ok) {
        logWarn(`[models] Registry fetch failed: HTTP ${resp.status}`);
        return;
      }
      const data = await resp.json();
      const entries = parseModelsDevResponse(data);
      const cache: RegistryCache = { ts: Date.now(), m: entries };
      localStorage.setItem(REGISTRY_CACHE_KEY, JSON.stringify(cache));
      logDebug(`[models] Registry refreshed: ${Object.keys(entries).length} model entries cached`);
    } catch (e) {
      logWarn(`[models] Registry refresh failed: ${e}`);
    } finally {
      fetchPromise = null;
    }
  })();
  return fetchPromise;
}

/**
 * Find a cache entry by modelId, trying exact match then prefix-stripping.
 * Returns the tuple or undefined.
 */
function findCacheEntry(
  m: RegistryCache["m"],
  modelId: string,
): [context: number, output: number, name: string] | undefined {
  const entry = m[modelId];
  if (entry) return entry;

  const slashIdx = modelId.indexOf("/");
  if (slashIdx !== -1) {
    return m[modelId.slice(slashIdx + 1)];
  }
  return undefined;
}

/**
 * Build a ModelInfo from a cache entry and promote it into MODEL_INDEX
 * so subsequent sync lookups are instant.
 */
function promoteEntry(
  modelId: string,
  entry: [context: number, output: number, name: string],
): ModelInfo {
  const [context, output, name] = entry;
  const info: ModelInfo = { id: modelId, name, contextWindow: context, maxOutputTokens: output };
  MODEL_INDEX.set(modelId, info);
  return info;
}

/**
 * Look up a model from the localStorage cache on demand.
 * If found, promotes it into MODEL_INDEX so subsequent lookups are instant.
 * If localStorage has no cache, fetches from models.dev first, then retries.
 */
async function lookupRegistryModel(modelId: string): Promise<ModelInfo | undefined> {
  if (!hasLocalStorage()) {
    logDebug("[models] localStorage unavailable, cannot look up registry model");
    return undefined;
  }

  try {
    const raw = localStorage.getItem(REGISTRY_CACHE_KEY);
    if (raw) {
      const cache: RegistryCache = JSON.parse(raw);
      const entry = findCacheEntry(cache.m, modelId);
      if (entry) return promoteEntry(modelId, entry);

      // Cache exists but model not found — trigger background refresh if stale
      if (Date.now() - cache.ts > REGISTRY_CACHE_MAX_AGE_MS) {
        void refreshRegistryCache();
      }
      return undefined;
    }
  } catch (e) {
    logWarn(`[models] Failed to read registry cache: ${e}`);
  }

  // No cache at all — fetch, populate localStorage, then retry lookup
  await refreshRegistryCache();
  try {
    const raw = localStorage.getItem(REGISTRY_CACHE_KEY);
    if (!raw) return undefined;
    const cache: RegistryCache = JSON.parse(raw);
    const entry = findCacheEntry(cache.m, modelId);
    if (entry) return promoteEntry(modelId, entry);
  } catch (e) {
    logWarn(`[models] Failed to read registry cache after refresh: ${e}`);
  }
  return undefined;
}
