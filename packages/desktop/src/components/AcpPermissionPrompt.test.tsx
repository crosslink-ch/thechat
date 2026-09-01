import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AcpPermissionRequest } from "@thechat/shared";
import { AcpPermissionPrompt } from "./AcpPermissionPrompt";

const request: AcpPermissionRequest = {
  id: "permission-42",
  title: "Run formatter?",
  description: "The adapter wants to run the formatter.",
  options: [
    { id: "allow_once", label: "Allow once", kind: "allow_once" },
    { id: "allow_always", label: "Always allow formatter", kind: "allow_always" },
    { id: "reject_once", label: "Reject once", kind: "reject_once" },
    { id: "reject_always", label: "Always reject formatter", kind: "reject_always" },
  ],
  toolCallId: "tool-1",
};

describe("AcpPermissionPrompt", () => {
  it("renders only the exact choices offered by the adapter and returns exact IDs", () => {
    const onChoice = vi.fn();
    render(<AcpPermissionPrompt request={request} onChoice={onChoice} />);

    expect(screen.getByText("Run formatter?")).toBeInTheDocument();
    expect(screen.getByText("The adapter wants to run the formatter.")).toBeInTheDocument();
    for (const option of request.options) {
      fireEvent.click(screen.getByRole("button", { name: option.label }));
      expect(onChoice).toHaveBeenLastCalledWith(option.id);
    }
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/feedback/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(request.options.length);
  });

  it("does not invent missing allow or reject choices", () => {
    render(
      <AcpPermissionPrompt
        request={{
          ...request,
          options: [
            {
              id: "custom",
              kind: "allow_once",
              label: "Ask my administrator",
            },
          ],
        }}
        onChoice={vi.fn()}
        busy
      />,
    );

    expect(screen.getByRole("button", { name: "Ask my administrator" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /allow/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reject|deny/i })).not.toBeInTheDocument();
  });
});
