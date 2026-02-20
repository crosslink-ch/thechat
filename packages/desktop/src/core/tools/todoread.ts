import { getTodos } from "../todo";
import { defineTool } from "./define";

export const todoReadTool = defineTool({
  name: "todoread",
  description: `Read the current todo list. Returns all tasks with their status.
Use this to check progress and see what tasks remain.`,
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: () => {
    const todos = getTodos();
    return {
      todos,
      total: todos.length,
      pending: todos.filter((t) => t.status === "pending").length,
      in_progress: todos.filter((t) => t.status === "in_progress").length,
      completed: todos.filter((t) => t.status === "completed").length,
    };
  },
});
