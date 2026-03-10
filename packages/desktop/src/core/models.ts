/**
 * Centralized model registry with per-model output token limits.
 *
 * When making API requests, the effective max_tokens is:
 *   Math.min(model.maxOutputTokens, OUTPUT_TOKEN_MAX)
 *
 * This prevents truncated responses (stop_reason "length") while
 * respecting both model capabilities and a global ceiling.
 */

/** Global ceiling for output tokens across all models. */
export const OUTPUT_TOKEN_MAX = 64_000;

/** Default reasoning effort used across all providers ("high" is the highest commonly supported value). */
export const DEFAULT_REASONING_EFFORT = "high";

export interface ModelInfo {
  id: string;
  name: string;
  maxOutputTokens: number;
  contextWindow: number;
  /** Explicit input token limit, if stricter than contextWindow - maxOutputTokens. */
  inputLimit?: number;
}

// ---------------------------------------------------------------------------
// Anthropic models
// ---------------------------------------------------------------------------

export const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", maxOutputTokens: 128_000, contextWindow: 200_000 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", maxOutputTokens: 64_000, contextWindow: 200_000 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", maxOutputTokens: 64_000, contextWindow: 200_000 },
];

// ---------------------------------------------------------------------------
// Codex (OpenAI) models
// ---------------------------------------------------------------------------

export const CODEX_MODELS: ModelInfo[] = [
  { id: "gpt-5.4", name: "GPT-5.4", maxOutputTokens: 128_000, contextWindow: 1_050_000, inputLimit: 922_000 },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", maxOutputTokens: 128_000, contextWindow: 400_000, inputLimit: 272_000 },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

const MODEL_INDEX = new Map<string, ModelInfo>();
for (const m of [...ANTHROPIC_MODELS, ...CODEX_MODELS]) {
  MODEL_INDEX.set(m.id, m);
}

/**
 * Get the full model info for a known model, or undefined for unknown models.
 */
export function getModelInfo(modelId: string): ModelInfo | undefined {
  return MODEL_INDEX.get(modelId);
}

/**
 * Get the effective max output tokens for a model, capped by OUTPUT_TOKEN_MAX.
 * Falls back to OUTPUT_TOKEN_MAX if the model is unknown.
 */
export function getMaxOutputTokens(modelId: string): number {
  const info = MODEL_INDEX.get(modelId);
  if (!info) return OUTPUT_TOKEN_MAX;
  return Math.min(info.maxOutputTokens, OUTPUT_TOKEN_MAX);
}
