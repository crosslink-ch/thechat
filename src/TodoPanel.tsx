import { useState } from "react";
import type { TodoItem } from "./core/types";

interface TodoPanelProps {
  todos: TodoItem[];
}

const STATUS_ICONS: Record<string, string> = {
  pending: "\u25CB",       // ○
  in_progress: "\u25D0",  // ◐
  completed: "\u25CF",    // ●
  cancelled: "\u2014",    // —
};

export function TodoPanel({ todos }: TodoPanelProps) {
  const [expanded, setExpanded] = useState(true);

  if (todos.length === 0) return null;

  const pending = todos.filter((t) => t.status === "pending").length;
  const inProgress = todos.filter((t) => t.status === "in_progress").length;
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  return (
    <div className="todo-panel">
      <button className="todo-panel-toggle" onClick={() => setExpanded(!expanded)}>
        <span className="todo-panel-chevron">{expanded ? "\u25BE" : "\u25B8"}</span>
        <span className="todo-panel-title">Tasks</span>
        <span className="todo-panel-summary">
          {completed}/{total} done
          {inProgress > 0 && ` \u00B7 ${inProgress} active`}
          {pending > 0 && ` \u00B7 ${pending} pending`}
        </span>
      </button>
      {expanded && (
        <div className="todo-panel-list">
          {todos.map((todo) => (
            <div key={todo.id} className={`todo-item todo-status-${todo.status}`}>
              <span className={`todo-icon ${todo.status === "in_progress" ? "todo-icon-active" : ""}`}>
                {STATUS_ICONS[todo.status] ?? "\u25CB"}
              </span>
              <span className="todo-content">{todo.content}</span>
              {todo.priority && (
                <span className={`todo-priority todo-priority-${todo.priority}`}>
                  {todo.priority}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
