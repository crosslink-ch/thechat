import { setTodos } from "../todo";
import type { TodoItem } from "../types";
import { defineTool } from "./define";

export const todoWriteTool = defineTool({
  name: "todowrite",
  description: `Update the todo list. Pass the complete list of todos — this replaces the current list.
Each todo has an id, content, status (pending/in_progress/completed/cancelled), and optional priority.
Use this to track multi-step tasks and show progress to the user.`,
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique identifier for the task" },
            content: { type: "string", description: "Description of the task" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
              description: "Current status of the task",
            },
            priority: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "Priority level",
            },
          },
          required: ["id", "content", "status"],
        },
        description: "The complete todo list (replaces current list)",
      },
    },
    required: ["todos"],
  },
  execute: (args, context) => {
    const { todos } = args as { todos: TodoItem[] };
    setTodos(todos, context?.convId);
    const remaining = todos.filter(
      (t) => t.status !== "completed" && t.status !== "cancelled",
    ).length;
    return { updated: true, total: todos.length, remaining };
  },
});
