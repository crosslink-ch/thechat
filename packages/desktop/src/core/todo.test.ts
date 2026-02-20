import { describe, it, expect, vi, beforeEach } from "vitest";

let getTodos: typeof import("./todo").getTodos;
let setTodos: typeof import("./todo").setTodos;
let resetTodos: typeof import("./todo").resetTodos;
let onTodoUpdate: typeof import("./todo").onTodoUpdate;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("./todo");
  getTodos = mod.getTodos;
  setTodos = mod.setTodos;
  resetTodos = mod.resetTodos;
  onTodoUpdate = mod.onTodoUpdate;
});

describe("todo store", () => {
  it("starts with empty todos", () => {
    expect(getTodos()).toEqual([]);
  });

  it("sets and gets todos", () => {
    const todos = [
      { id: "1", content: "Do something", status: "pending" as const },
    ];
    setTodos(todos);
    expect(getTodos()).toEqual(todos);
  });

  it("returns a copy (not a reference)", () => {
    const todos = [
      { id: "1", content: "Task", status: "pending" as const },
    ];
    setTodos(todos);
    const retrieved = getTodos();
    retrieved.push({ id: "2", content: "Another", status: "pending" as const });
    expect(getTodos()).toHaveLength(1);
  });

  it("resets todos", () => {
    setTodos([{ id: "1", content: "Task", status: "pending" }]);
    resetTodos();
    expect(getTodos()).toEqual([]);
  });

  it("notifies listener on set", () => {
    const listener = vi.fn();
    onTodoUpdate(listener);

    const todos = [{ id: "1", content: "Task", status: "pending" as const }];
    setTodos(todos);

    expect(listener).toHaveBeenCalledWith(todos);
  });

  it("notifies listener on reset", () => {
    const listener = vi.fn();
    onTodoUpdate(listener);

    setTodos([{ id: "1", content: "Task", status: "pending" }]);
    resetTodos();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith([]);
  });

  it("unsubscribe removes the listener", () => {
    const listener = vi.fn();
    const unsub = onTodoUpdate(listener);
    unsub();

    setTodos([{ id: "1", content: "Task", status: "pending" }]);
    expect(listener).not.toHaveBeenCalled();
  });
});
