import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QuestionOverlay } from "./QuestionOverlay";
import type { QuestionRequest } from "../core/types";

function makeRequest(
  overrides?: Partial<QuestionRequest>,
): QuestionRequest {
  return {
    id: "1",
    questions: [
      {
        question: "What is your name?",
        header: "Name",
        options: [
          { label: "Alice", description: "Option A" },
          { label: "Bob", description: "Option B" },
        ],
      },
    ],
    resolve: vi.fn(),
    reject: vi.fn(),
    ...overrides,
  };
}

describe("QuestionOverlay", () => {
  it("submits selected option", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionOverlay request={makeRequest()} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    fireEvent.click(screen.getByText("Alice"));
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith([["Alice"]]);
  });

  it("submits custom text via Submit button", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionOverlay request={makeRequest()} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    const input = screen.getByPlaceholderText("Type your own answer...");
    fireEvent.change(input, { target: { value: "my-custom-answer" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith([["my-custom-answer"]]);
  });

  it("submits custom text via Enter key", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionOverlay request={makeRequest()} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    const input = screen.getByPlaceholderText("Type your own answer...");
    fireEvent.change(input, { target: { value: "Charlie" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith([["Charlie"]]);
  });

  it("selecting an option deactivates custom but preserves its text", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionOverlay request={makeRequest()} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    const input = screen.getByPlaceholderText("Type your own answer...");
    fireEvent.change(input, { target: { value: "Charlie" } });
    // Select a predefined option — custom text should stay but not be submitted
    fireEvent.click(screen.getByText("Bob"));
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith([["Bob"]]);
    expect(input).toHaveValue("Charlie");
  });

  it("custom text replaces button selection for single-select", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionOverlay request={makeRequest()} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByPlaceholderText("Type your own answer...");
    fireEvent.change(input, { target: { value: "Charlie" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith([["Charlie"]]);
  });

  it("includes custom inputs across multiple questions", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionOverlay
        request={makeRequest({
          questions: [
            {
              question: "Bot name?",
              header: "Name",
              options: [{ label: "Default", description: "Use default" }],
            },
            {
              question: "Webhook URL?",
              header: "URL",
              options: [{ label: "Skip", description: "Set later" }],
            },
            {
              question: "Workspace ID?",
              header: "ID",
              options: [{ label: "Default WS", description: "Use default" }],
            },
          ],
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    const inputs = screen.getAllByPlaceholderText("Type your own answer...");
    fireEvent.change(inputs[0], { target: { value: "MyBot" } });
    fireEvent.change(inputs[1], { target: { value: "https://example.com/hook" } });
    fireEvent.change(inputs[2], { target: { value: "ws-12345" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith([
      ["MyBot"],
      ["https://example.com/hook"],
      ["ws-12345"],
    ]);
  });

  it("multi-select appends custom text to button selections", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionOverlay
        request={makeRequest({
          questions: [
            {
              question: "Pick features",
              header: "Features",
              options: [
                { label: "Auth", description: "Authentication" },
                { label: "DB", description: "Database" },
              ],
              multiple: true,
            },
          ],
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Auth"));
    const input = screen.getByPlaceholderText("Type your own answer...");
    fireEvent.change(input, { target: { value: "Logging" } });
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith([["Auth", "Logging"]]);
  });

  it("multi-select allows deselecting custom after typing", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionOverlay
        request={makeRequest({
          questions: [
            {
              question: "Pick features",
              header: "Features",
              options: [
                { label: "Auth", description: "Authentication" },
                { label: "DB", description: "Database" },
              ],
              multiple: true,
            },
          ],
        })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Auth"));
    const input = screen.getByPlaceholderText("Type your own answer...");
    fireEvent.change(input, { target: { value: "Logging" } });
    // Click the custom option row to deselect it
    fireEvent.click(input.closest(".question-option-custom")!);
    fireEvent.click(screen.getByText("Submit"));

    // Custom deselected, text preserved in input but not submitted
    expect(onSubmit).toHaveBeenCalledWith([["Auth"]]);
    expect(input).toHaveValue("Logging");
  });

  it("empty custom text is excluded from results", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionOverlay request={makeRequest()} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );

    const input = screen.getByPlaceholderText("Type your own answer...");
    // Activate custom by focusing, but leave it empty
    fireEvent.focus(input);
    fireEvent.click(screen.getByText("Submit"));

    expect(onSubmit).toHaveBeenCalledWith([[]]);
  });
});
