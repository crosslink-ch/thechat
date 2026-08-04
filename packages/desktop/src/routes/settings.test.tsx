import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAuthStore } from "../stores/auth";
import { SettingsRoute } from "./settings";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

beforeEach(() => {
  invokeMock.mockClear();
  useAuthStore.setState({
    user: {
      id: "user-1",
      name: "Bruno Example",
      email: "bruno@example.com",
      avatar: null,
      type: "human",
    },
    token: "better-auth-session",
    loading: false,
  });
});

describe("SettingsRoute", () => {
  it("presents the current account name and email as intentionally read-only", () => {
    render(<SettingsRoute />);

    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Bruno Example");
    expect(screen.getByLabelText("Name")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Email address")).toHaveValue("bruno@example.com");
    expect(screen.getByLabelText("Email address")).toHaveAttribute("readonly");
    expect(
      screen.getByText(/Profile editing is not available in TheChat yet/i),
    ).toBeInTheDocument();
  });

  it("does not expose Agent Chat, model, provider, credential, or MCP settings", () => {
    render(<SettingsRoute />);

    for (const removedLabel of [
      "Agent Chat",
      "Provider",
      "API Key",
      "Model",
      "Reasoning Effort",
      "MCP Servers",
      "Inherit config from workspace",
      "Configure MCP Server",
      "ChatGPT",
    ]) {
      expect(screen.queryByText(removedLabel, { exact: false })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("handles a missing cached user without falling back to local Agent Chat settings", () => {
    useAuthStore.setState({ user: null, token: null, loading: false });

    render(<SettingsRoute />);

    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByText("Sign in to view your profile")).toBeInTheDocument();
    expect(screen.queryByText("Provider", { exact: false })).not.toBeInTheDocument();
  });
});
