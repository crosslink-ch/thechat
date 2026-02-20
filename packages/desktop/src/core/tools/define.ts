import type { ToolDefinition } from "../types";

export function defineTool<TArgs = Record<string, unknown>>(
  tool: ToolDefinition<TArgs>,
): ToolDefinition<TArgs> {
  return tool;
}
