/**
 * Context compaction — detects when the conversation context approaches
 * the model's limit and compresses it via LLM summarization.
 *
 * Strategy (adapted from OpenCode):
 *   1. Prune old tool results (replace with placeholder text)
 *   2. If still near the limit, run a full LLM summarization call
 *   3. Replace the message history with the summary for continuation
 */

import { getModelInfo, getMaxOutputTokens } from "./models";
import { debug as logDebug, warn as logWarn, error as logError, formatError } from "../log";
import type { StreamResult, StreamEvent } from "./types";

/** Token buffer reserved beyond maxOutputTokens to avoid overflow. */
const COMPACTION_BUFFER = 20_000;

/** Number of recent user turns whose tool results are protected from pruning. */
const PRUNE_PROTECT_TURNS = 2;

const COMPACTION_PROMPT = `\
Provide a detailed summary for continuing this conversation.
Focus on information needed to continue the conversation, including what we did, \
what we're doing, which files we're working on, and what we're going to do next.
This summary will replace the conversation history, so include all important context.

When constructing the summary, use this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give that are relevant]
- [If there is a plan or spec, include information about it]

## Discoveries

[Notable things learned during this conversation]

## Accomplished

[What work has been completed, what is in progress, and what remains?]

## Relevant files / directories

[List of relevant files read, edited, or created]
---`;

/**
 * Check whether the current token usage is approaching the model's context limit.
 *
 * Uses total_tokens (prompt + completion) from the last call as a proxy for the
 * next call's input size, since the current output becomes part of the next input.
 *
 * For models with an explicit inputLimit (e.g. GPT-5.x Codex), the usable input
 * is capped by that limit rather than derived from contextWindow - maxOutput.
 *
 * Returns false for unknown models (no context window info available).
 */
export async function isOverflow(totalTokens: number, modelId: string): Promise<boolean> {
  const model = await getModelInfo(modelId);
  if (!model) return false;

  const maxOutput = await getMaxOutputTokens(modelId);
  const maxInput = model.inputLimit ?? model.contextWindow - maxOutput;
  const usable = maxInput - COMPACTION_BUFFER;
  return totalTokens >= usable;
}

/**
 * Replace old tool result contents with a short placeholder to reduce token count.
 * Protects the last PRUNE_PROTECT_TURNS user turns from pruning.
 *
 * Mutates messages in place. Returns estimated tokens freed.
 */
export function pruneToolResults(messages: Array<Record<string, unknown>>): number {
  // Walk backward to find the boundary of protected turns.
  // Everything from protectFromIdx onward is protected from pruning.
  // Default is 1 (protect everything except system prompt at index 0).
  let turnCount = 0;
  let protectFromIdx = 1;

  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role === "user") {
      turnCount++;
      if (turnCount >= PRUNE_PROTECT_TURNS) {
        protectFromIdx = i;
        break;
      }
    }
  }

  const placeholder = "[Old tool result content cleared]";
  let freedTokens = 0;

  for (let i = 1; i < protectFromIdx; i++) {
    const msg = messages[i];
    if (msg.role === "tool" && typeof msg.content === "string") {
      const content = msg.content as string;
      // Only replace if the content is meaningfully larger than the placeholder
      if (content.length > placeholder.length * 2) {
        freedTokens += (content.length - placeholder.length) / 4;
        msg.content = placeholder;
      }
    }
  }

  if (freedTokens > 0) {
    logDebug(`[compaction] Pruned ~${Math.round(freedTokens)} estimated tokens from old tool results`);
  }

  return freedTokens;
}

/**
 * Run LLM-based context compaction.
 *
 * 1. Prunes old tool results to shrink the context
 * 2. Sends the full (pruned) conversation + compaction prompt to the model (no tools)
 * 3. Replaces the message array contents with: system prompt + summary + continue prompt
 *
 * Mutates the messages array in place.
 * Returns true if compaction succeeded.
 */
export async function compactMessages(
  messages: Array<Record<string, unknown>>,
  callProviderFn: (messages: Array<Record<string, unknown>>) => Promise<StreamResult>,
  onEvents: (events: StreamEvent[]) => void,
): Promise<boolean> {
  logDebug("[compaction] Starting context compaction...");

  // Step 1: Prune old tool results first to maximize chance of fit
  pruneToolResults(messages);

  // Step 2: Build compaction request — all current messages + summarization prompt
  const compactionMessages = [
    ...messages,
    { role: "user" as const, content: COMPACTION_PROMPT },
  ];

  try {
    // Run the summarization call silently (no streaming events to the UI)
    const result = await callProviderFn(compactionMessages);
    const summary = result.text?.trim();

    if (!summary) {
      logWarn("[compaction] Compaction produced empty summary");
      return false;
    }

    logDebug(`[compaction] Compaction complete, summary: ${summary.length} chars`);

    // Step 3: Replace message history with compact version
    const systemMsg = messages[0];
    messages.length = 0;
    messages.push(
      systemMsg,
      { role: "user", content: "What did we do so far?" },
      { role: "assistant", content: summary },
      { role: "user", content: "Continue with the task." },
    );

    onEvents([{ type: "compaction", summary }]);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    logError(`[compaction] Compaction failed: ${formatError(e)}`);
    onEvents([{
      type: "error",
      error: "Context compaction failed — conversation may be too large to summarize.",
    }]);
    return false;
  }
}
