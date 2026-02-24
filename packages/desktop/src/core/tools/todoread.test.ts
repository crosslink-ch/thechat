import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../todo", () => ({
  getTodos: vi.fn(),
}));

import { getTodos } from "../todo";
import { todoReadTool } from "./todoread";

const mockGetTodos = vi.mocked(getTodos);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("todoReadTool", () => {
  it("has correct name", () => {
    expect(todoReadTool.name).toBe("todoread");
  });

  it("returns todos with counts using convId", () => {
    mockGetTodos.mockReturnValue([
      { id: "1", content: "Task 1", status: "pending" },
      { id: "2", content: "Task 2", status: "completed" },
      { id: "3", content: "Task 3", status: "in_progress" },
    ]);

    const result = todoReadTool.execute({}, { convId: "conv-1" }) as {
      total: number;
      pending: number;
      in_progress: number;
      completed: number;
    };

    expect(mockGetTodos).toHaveBeenCalledWith("conv-1");
    expect(result.total).toBe(3);
    expect(result.pending).toBe(1);
    expect(result.in_progress).toBe(1);
    expect(result.completed).toBe(1);
  });

  it("returns empty state when no todos", () => {
    mockGetTodos.mockReturnValue([]);

    const result = todoReadTool.execute({}, { convId: "conv-1" }) as { total: number };
    expect(result.total).toBe(0);
  });

  it("passes undefined convId when no context", () => {
    mockGetTodos.mockReturnValue([]);

    todoReadTool.execute({});

    expect(mockGetTodos).toHaveBeenCalledWith(undefined);
  });
});
