import type { TodoItem } from "./types";

type TodoListener = (todos: TodoItem[]) => void;

let todos: TodoItem[] = [];
let listener: TodoListener | null = null;

export function getTodos(): TodoItem[] {
  return [...todos];
}

export function setTodos(newTodos: TodoItem[]): void {
  todos = [...newTodos];
  listener?.(getTodos());
}

export function resetTodos(): void {
  todos = [];
  listener?.(getTodos());
}

export function onTodoUpdate(callback: TodoListener): () => void {
  listener = callback;
  return () => {
    if (listener === callback) {
      listener = null;
    }
  };
}
