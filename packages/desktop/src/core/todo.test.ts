import { describe, it, expect, beforeEach } from "vitest";
import { useTodoStore, getTodos, setTodos, clearTodos } from "./todo";

beforeEach(() => {
  useTodoStore.setState({ todos: {} });
});

describe("todo store", () => {
  it("starts with empty todos", () => {
    expect(getTodos("conv-1")).toEqual([]);
  });

  it("sets and gets todos for a conversation", () => {
    const todos = [
      { id: "1", content: "Do something", status: "pending" as const },
    ];
    setTodos(todos, "conv-1");
    expect(getTodos("conv-1")).toEqual(todos);
  });

  it("returns a copy (not a reference)", () => {
    const todos = [
      { id: "1", content: "Task", status: "pending" as const },
    ];
    setTodos(todos, "conv-1");
    const retrieved = getTodos("conv-1");
    retrieved.push({ id: "2", content: "Another", status: "pending" as const });
    expect(getTodos("conv-1")).toHaveLength(1);
  });

  it("isolates todos per conversation", () => {
    setTodos([{ id: "1", content: "Task A", status: "pending" }], "conv-1");
    setTodos([{ id: "2", content: "Task B", status: "completed" }], "conv-2");

    expect(getTodos("conv-1")).toEqual([
      { id: "1", content: "Task A", status: "pending" },
    ]);
    expect(getTodos("conv-2")).toEqual([
      { id: "2", content: "Task B", status: "completed" },
    ]);
  });

  it("uses _default key when no convId is provided", () => {
    setTodos([{ id: "1", content: "Default task", status: "pending" }]);
    expect(getTodos()).toEqual([
      { id: "1", content: "Default task", status: "pending" },
    ]);
    // Should not bleed into a named conversation
    expect(getTodos("conv-1")).toEqual([]);
  });

  it("clears todos for a specific conversation", () => {
    setTodos([{ id: "1", content: "Task A", status: "pending" }], "conv-1");
    setTodos([{ id: "2", content: "Task B", status: "pending" }], "conv-2");

    clearTodos("conv-1");

    expect(getTodos("conv-1")).toEqual([]);
    expect(getTodos("conv-2")).toEqual([
      { id: "2", content: "Task B", status: "pending" },
    ]);
  });

  it("clearTodos is a no-op for non-existent conversation", () => {
    setTodos([{ id: "1", content: "Task", status: "pending" }], "conv-1");
    clearTodos("conv-999");
    expect(getTodos("conv-1")).toHaveLength(1);
  });
});
