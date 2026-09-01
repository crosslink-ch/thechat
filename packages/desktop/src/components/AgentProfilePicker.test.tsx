import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AcpProfile } from "@thechat/shared";
import { AgentProfilePicker } from "./AgentProfilePicker";

const profiles: AcpProfile[] = [
  {
    id: "codex",
    name: "Codex",
    executable: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.7.0"],
    inheritEnv: [],
  },
  {
    id: "disabled",
    name: "Old adapter",
    executable: "old-agent",
    args: [],
    inheritEnv: [],
    disabled: true,
  },
];

describe("AgentProfilePicker", () => {
  it("selects enabled profiles and marks disabled profiles unavailable", () => {
    const onChange = vi.fn();
    render(
      <AgentProfilePicker
        profiles={profiles}
        value="codex"
        onChange={onChange}
      />,
    );

    const picker = screen.getByRole("combobox", { name: "Agent profile" });
    expect(picker).toHaveValue("codex");
    expect(screen.getByRole("option", { name: "Old adapter (disabled)" })).toBeDisabled();
    fireEvent.change(picker, { target: { value: "codex" } });
    expect(onChange).toHaveBeenCalledWith("codex");
  });

  it("preserves a missing bound profile instead of silently selecting a fallback", () => {
    const onChange = vi.fn();
    render(
      <AgentProfilePicker
        profiles={profiles}
        value="deleted-profile"
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Agent profile" })).toHaveValue(
      "deleted-profile",
    );
    expect(screen.getByText(/profile deleted-profile is unavailable/i)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("locks the profile after conversation creation", () => {
    render(
      <AgentProfilePicker
        profiles={profiles}
        value="codex"
        onChange={vi.fn()}
        locked
      />,
    );

    expect(screen.getByRole("combobox", { name: "Agent profile" })).toBeDisabled();
    expect(screen.getByText("Profile locked for this conversation")).toBeInTheDocument();
  });
});
