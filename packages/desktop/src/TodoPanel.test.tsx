import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TodoPanel } from "./TodoPanel";
import type { TodoItem } from "./core/types";

const makeTodo = (overrides: Partial<TodoItem> & { id: string }): TodoItem => ({
  content: "Task",
  status: "pending",
  ...overrides,
});

describe("TodoPanel", () => {
  it("renders nothing when todos is empty", () => {
    const { container } = render(<TodoPanel todos={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders tasks when todos are provided", () => {
    const todos = [makeTodo({ id: "1", content: "Write tests" })];
    render(<TodoPanel todos={todos} />);
    expect(screen.getByText("Write tests")).toBeInTheDocument();
  });

  it("shows correct counts in header", () => {
    const todos = [
      makeTodo({ id: "1", status: "completed" }),
      makeTodo({ id: "2", status: "pending" }),
      makeTodo({ id: "3", status: "in_progress" }),
    ];
    render(<TodoPanel todos={todos} />);
    expect(screen.getByText(/1\/3 done/)).toBeInTheDocument();
    expect(screen.getByText(/1 active/)).toBeInTheDocument();
    expect(screen.getByText(/1 pending/)).toBeInTheDocument();
  });

  it("collapses and expands on click", () => {
    const todos = [makeTodo({ id: "1", content: "Visible task" })];
    render(<TodoPanel todos={todos} />);

    expect(screen.getByText("Visible task")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Tasks"));
    expect(screen.queryByText("Visible task")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Tasks"));
    expect(screen.getByText("Visible task")).toBeInTheDocument();
  });

  it("shows priority badges", () => {
    const todos = [makeTodo({ id: "1", priority: "high" })];
    render(<TodoPanel todos={todos} />);
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("applies strikethrough to completed items", () => {
    const todos = [makeTodo({ id: "1", content: "Done task", status: "completed" })];
    render(<TodoPanel todos={todos} />);
    const el = screen.getByText("Done task");
    expect(el.className).toContain("line-through");
  });

  // This is the exact bug that was in production: early return before useMemo
  // caused "Rendered more hooks than during the previous render"
  it("handles transition from empty to non-empty todos without error", () => {
    const { rerender } = render(<TodoPanel todos={[]} />);

    // Transition to non-empty — this would crash if hooks are called conditionally
    const todos = [makeTodo({ id: "1", content: "New task" })];
    rerender(<TodoPanel todos={todos} />);

    expect(screen.getByText("New task")).toBeInTheDocument();
  });

  it("handles transition from non-empty back to empty", () => {
    const todos = [makeTodo({ id: "1", content: "Going away" })];
    const { rerender } = render(<TodoPanel todos={todos} />);
    expect(screen.getByText("Going away")).toBeInTheDocument();

    rerender(<TodoPanel todos={[]} />);
    expect(screen.queryByText("Going away")).not.toBeInTheDocument();
  });

  it("survives multiple empty-to-filled transitions", () => {
    const { rerender } = render(<TodoPanel todos={[]} />);

    for (let i = 0; i < 3; i++) {
      rerender(<TodoPanel todos={[makeTodo({ id: String(i), content: `Task ${i}` })]} />);
      expect(screen.getByText(`Task ${i}`)).toBeInTheDocument();

      rerender(<TodoPanel todos={[]} />);
      expect(screen.queryByText(`Task ${i}`)).not.toBeInTheDocument();
    }
  });
});
