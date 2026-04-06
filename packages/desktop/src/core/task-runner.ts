import { runChatLoop } from "./loop";
import { useCodexAuthStore } from "../stores/codex-auth";
import { useAnthropicAuthStore } from "../stores/anthropic-auth";
import { getEffectiveConfig } from "../lib/effective-config";
import type { StreamEvent, ToolDefinition } from "./types";

interface TaskRunnerConfig {
  availableTools: ToolDefinition[];
  cwd?: string;
}

let config: TaskRunnerConfig | null = null;

// Tools allowed for subtasks — no recursion (task, batch), no UI (question, todowrite, todoread)
const ALLOWED_TASK_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "multiedit",
  "glob",
  "grep",
  "list",
  "shell",
  "get_current_time",
]);

export function setTaskRunnerConfig(cfg: TaskRunnerConfig): void {
  config = cfg;
}

export async function runTask(prompt: string, signal?: AbortSignal, convId?: string, cwd?: string): Promise<string> {
  if (!config) {
    throw new Error("Task runner not configured. Call setTaskRunnerConfig first.");
  }

  const { config: appConfig } = await getEffectiveConfig();
  const provider = appConfig.provider ?? "openrouter";

  let codexAuth: { accessToken: string; accountId: string } | undefined;
  let anthropicAuth: { accessToken: string } | undefined;

  if (provider === "codex") {
    codexAuth = await useCodexAuthStore.getState().getValidToken();
  }
  if (provider === "anthropic") {
    anthropicAuth = await useAnthropicAuthStore.getState().getValidToken();
  }

  const tools = config.availableTools.filter((t) => ALLOWED_TASK_TOOLS.has(t.name));

  const textParts: string[] = [];

  const onEvents = (events: StreamEvent[]) => {
    for (const event of events) {
      if (event.type === "text-delta") {
        textParts.push(event.text);
      }
    }
  };

  const resolvedCwd = cwd ?? config.cwd;

  const systemPromptParts = [
    "You are a helpful sub-agent completing a specific task. Be concise and focused. " +
      "Complete the task and report results clearly.",
  ];
  if (resolvedCwd) {
    systemPromptParts.push(`Working directory: ${resolvedCwd}`);
  }

  await runChatLoop({
    apiKey: appConfig.api_key,
    model: appConfig.providers[provider].model,
    messages: [{ role: "user", content: prompt }],
    systemPrompt: systemPromptParts.join("\n"),
    tools,
    maxToolRoundtrips: Infinity,
    signal,
    cwd: resolvedCwd,
    convId,
    provider: codexAuth ? "codex" : provider === "anthropic" ? "anthropic" : "openrouter",
    codexAuth,
    anthropicAuth,
    onEvents,
  });

  return textParts.join("") || "(Task completed with no text output)";
}
