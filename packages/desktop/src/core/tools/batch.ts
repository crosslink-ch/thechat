import type { ToolDefinition } from "../types";
import { defineTool } from "./define";

let toolRegistry: Map<string, ToolDefinition> = new Map();

export function setBatchToolRegistry(tools: ToolDefinition[]): void {
  toolRegistry = new Map(tools.map((t) => [t.name, t]));
}

const DISALLOWED_TOOLS = new Set(["batch", "invalid"]);

interface BatchToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export const batchTool = defineTool({
  name: "batch",
  description: `Execute multiple tool calls in parallel. Use this when you need to run several independent operations at once.
Each tool call runs concurrently. Results are returned in the same order as the input.
Cannot nest batch calls or call the "invalid" tool.
If any individual tool call fails, other calls still complete.`,
  parameters: {
    type: "object",
    properties: {
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Name of the tool to call" },
            args: { type: "object", description: "Arguments for the tool" },
          },
          required: ["tool", "args"],
        },
        description: "Array of tool calls to execute in parallel",
      },
    },
    required: ["tool_calls"],
  },
  execute: async (args) => {
    const { tool_calls } = args as { tool_calls: BatchToolCall[] };

    const results = await Promise.all(
      tool_calls.map(async (call, index) => {
        if (DISALLOWED_TOOLS.has(call.tool)) {
          return {
            index,
            tool: call.tool,
            success: false,
            error: `Tool "${call.tool}" cannot be used inside batch`,
          };
        }

        const tool = toolRegistry.get(call.tool);
        if (!tool) {
          return {
            index,
            tool: call.tool,
            success: false,
            error: `Unknown tool: ${call.tool}`,
          };
        }

        try {
          const result = await tool.execute(call.args);
          return { index, tool: call.tool, success: true, result };
        } catch (e) {
          return {
            index,
            tool: call.tool,
            success: false,
            error: String(e),
          };
        }
      }),
    );

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    return { total: tool_calls.length, successful, failed, results };
  },
});
