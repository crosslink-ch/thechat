import type { ToolDefinition } from "@thechat/client/core/types";

export function defineTool<TArgs = Record<string, unknown>>(
  tool: ToolDefinition<TArgs>,
): ToolDefinition<TArgs> {
  return tool;
}
