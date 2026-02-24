import { runTask } from "../task-runner";
import type { ToolExecutionContext } from "../types";
import { defineTool } from "./define";

export const taskTool = defineTool({
  name: "task",
  description: `Launch a sub-agent to handle a complex task autonomously. The sub-agent has access to
file operation tools (read, write, edit, glob, grep, list, shell) but NOT to batch, task, question, or todo tools.
Use this for independent subtasks that don't need user interaction.
The sub-agent runs a full chat loop and returns its text output.`,
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed instructions for the sub-agent describing the task to complete",
      },
    },
    required: ["prompt"],
  },
  execute: async (args, context?: ToolExecutionContext) => {
    const { prompt } = args as { prompt: string };

    try {
      const result = await runTask(prompt, context?.signal, context?.convId);
      return { success: true, output: result };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
});
