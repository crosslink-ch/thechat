import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../todo", () => ({
  setTodos: vi.fn(),
}));

import { setTodos } from "../todo";
import { todoWriteTool } from "./todowrite";

const mockSetTodos = vi.mocked(setTodos);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("todoWriteTool", () => {
  it("has correct name", () => {
    expect(todoWriteTool.name).toBe("todowrite");
  });

  it("calls setTodos with convId and returns counts", () => {
    const todos = [
      { id: "1", content: "Task 1", status: "pending" as const },
      { id: "2", content: "Task 2", status: "completed" as const },
      { id: "3", content: "Task 3", status: "in_progress" as const },
    ];

    const result = todoWriteTool.execute({ todos }, { convId: "conv-1" }) as {
      updated: boolean;
      total: number;
      remaining: number;
    };

    expect(mockSetTodos).toHaveBeenCalledWith(todos, "conv-1");
    expect(result.updated).toBe(true);
    expect(result.total).toBe(3);
    expect(result.remaining).toBe(2); // pending + in_progress
  });

  it("passes undefined convId when no context", () => {
    const todos = [
      { id: "1", content: "Task 1", status: "pending" as const },
    ];

    todoWriteTool.execute({ todos });

    expect(mockSetTodos).toHaveBeenCalledWith(todos, undefined);
  });
});
