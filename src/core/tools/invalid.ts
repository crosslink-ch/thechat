import { defineTool } from "./define";

export const invalidTool = defineTool({
  name: "invalid",
  description: "This tool is used internally when the model calls an unknown tool. Do not use it directly.",
  parameters: {
    type: "object",
    properties: {
      error: {
        type: "string",
        description: "The error message explaining what went wrong",
      },
    },
    required: ["error"],
  },
  execute: (args) => {
    const { error } = args as { error: string };
    return { error };
  },
});
