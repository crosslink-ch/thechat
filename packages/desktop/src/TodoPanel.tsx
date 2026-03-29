import { useState, useMemo } from "react";
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

const priorityClasses: Record<string, string> = {
  high: "text-error bg-error-bg",
  medium: "text-accent bg-accent/10",
  low: "text-text-dimmed bg-elevated",
};

export function TodoPanel({ todos }: TodoPanelProps) {
  const [expanded, setExpanded] = useState(true);

  const { pending, inProgress, completed, total } = useMemo(() => {
    let p = 0, ip = 0, c = 0;
    for (const t of todos) {
      if (t.status === "pending") p++;
      else if (t.status === "in_progress") ip++;
      else if (t.status === "completed") c++;
    }
    return { pending: p, inProgress: ip, completed: c, total: todos.length };
  }, [todos]);

  if (todos.length === 0) return null;

  return (
    <div className="border-b border-border-subtle bg-surface">
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-none px-5 py-2.5 text-left text-[0.857rem] text-text-muted shadow-none transition-colors duration-150 hover:bg-hover"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="w-3 text-[0.714rem] text-text-dimmed">{expanded ? "\u25BE" : "\u25B8"}</span>
        <span className="font-semibold text-text-secondary">Tasks</span>
        <span className="ml-auto text-[0.786rem] text-text-dimmed">
          {completed}/{total} done
          {inProgress > 0 && ` \u00B7 ${inProgress} active`}
          {pending > 0 && ` \u00B7 ${pending} pending`}
        </span>
      </button>
      {expanded && (
        <div className="px-5 pb-2.5">
          {todos.map((todo) => {
            const isDone = todo.status === "completed" || todo.status === "cancelled";
            return (
              <div key={todo.id} className="flex items-start gap-2 py-1 text-[0.929rem] text-text-secondary">
                <span className={`w-4 shrink-0 text-center leading-normal ${todo.status === "in_progress" ? "animate-pulse" : ""}`}>
                  {STATUS_ICONS[todo.status] ?? "\u25CB"}
                </span>
                <span className={`flex-1 leading-normal ${isDone ? "text-text-dimmed line-through" : ""}`}>{todo.content}</span>
                {todo.priority && (
                  <span className={`shrink-0 rounded-md px-1.5 py-px text-[0.714rem] font-medium uppercase tracking-wider ${priorityClasses[todo.priority] ?? ""}`}>
                    {todo.priority}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
