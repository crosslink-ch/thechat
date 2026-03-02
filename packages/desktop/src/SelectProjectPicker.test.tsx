import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SelectProjectPicker, openSelectProjectPicker } from "./SelectProjectPicker";

describe("SelectProjectPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });


  it("submits typed path with Enter when query is not an existing recent project", () => {
    const onSelect = vi.fn();
    render(<SelectProjectPicker />);

    act(() => {
      openSelectProjectPicker(["/repo/a", "/repo/b"], onSelect);
    });

    const input = screen.getByPlaceholderText("Search recent projects or type a project path...");
    fireEvent.change(input, { target: { value: "/tmp/new-project" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("/tmp/new-project");
    expect(screen.queryByText("Select project")).not.toBeInTheDocument();
  });

  it("supports keyboard navigation to pick a recent project when typed option is present", () => {
    const onSelect = vi.fn();
    render(<SelectProjectPicker />);

    act(() => {
      openSelectProjectPicker(["/repo/a", "/repo/b"], onSelect);
    });

    const input = screen.getByPlaceholderText("Search recent projects or type a project path...");
    fireEvent.change(input, { target: { value: "/repo" } });

    // index 0 is typed option ('Use path: /repo'), index 1 is first recent (/repo/a)
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("/repo/a");
  });

  it("does not create a duplicate typed option when query exactly matches a recent project", () => {
    const onSelect = vi.fn();
    render(<SelectProjectPicker />);

    act(() => {
      openSelectProjectPicker(["/repo/a", "/repo/b"], onSelect);
    });

    const input = screen.getByPlaceholderText("Search recent projects or type a project path...");
    fireEvent.change(input, { target: { value: "/repo/a" } });

    expect(screen.queryByText("Use path: /repo/a")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("/repo/a");
  });

  it("closes on Escape without selecting", () => {
    const onSelect = vi.fn();
    render(<SelectProjectPicker />);

    act(() => {
      openSelectProjectPicker(["/repo/a"], onSelect);
    });

    const input = screen.getByPlaceholderText("Search recent projects or type a project path...");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByText("Select project")).not.toBeInTheDocument();
  });
});
