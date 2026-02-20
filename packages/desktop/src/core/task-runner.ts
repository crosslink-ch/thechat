import { runChatLoop } from "./loop";
import type { StreamEvent, ToolDefinition } from "./types";

interface TaskRunnerConfig {
  apiKey: string;
  model: string;
  availableTools: ToolDefinition[];
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

export async function runTask(prompt: string, signal?: AbortSignal): Promise<string> {
  if (!config) {
    throw new Error("Task runner not configured. Call setTaskRunnerConfig first.");
  }

  const tools = config.availableTools.filter((t) => ALLOWED_TASK_TOOLS.has(t.name));

  const textParts: string[] = [];

  const onEvent = (event: StreamEvent) => {
    if (event.type === "text-delta") {
      textParts.push(event.text);
    }
  };

  await runChatLoop({
    apiKey: config.apiKey,
    model: config.model,
    messages: [{ role: "user", content: prompt }],
    systemPrompt:
      "You are a helpful sub-agent completing a specific task. Be concise and focused. " +
      "Complete the task and report results clearly.",
    tools,
    maxToolRoundtrips: Infinity,
    signal,
    onEvent,
  });

  return textParts.join("") || "(Task completed with no text output)";
}
