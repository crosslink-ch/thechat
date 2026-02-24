import { create } from "zustand";
import type { TodoItem } from "./types";

interface TodoStoreState {
  todos: Record<string, TodoItem[]>;
}

export const useTodoStore = create<TodoStoreState>()(() => ({
  todos: {},
}));

const DEFAULT_KEY = "_default";

export function getTodos(convId?: string): TodoItem[] {
  const key = convId ?? DEFAULT_KEY;
  return [...(useTodoStore.getState().todos[key] ?? [])];
}

export function setTodos(newTodos: TodoItem[], convId?: string): void {
  const key = convId ?? DEFAULT_KEY;
  useTodoStore.setState((s) => ({
    todos: { ...s.todos, [key]: [...newTodos] },
  }));
}

export function clearTodos(convId: string): void {
  useTodoStore.setState((s) => {
    const { [convId]: _, ...rest } = s.todos;
    return { todos: rest };
  });
}
