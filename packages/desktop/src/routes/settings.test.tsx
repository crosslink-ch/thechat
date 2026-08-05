import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAuthStore } from "../stores/auth";
import { SettingsRoute } from "./settings";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));
const updateNameMock = vi.fn();
const profileEmail =
  "bruno.with.a.long.profile.address@example-organization.ch";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

beforeEach(() => {
  invokeMock.mockClear();
  updateNameMock.mockReset();
  updateNameMock.mockImplementation(async (name: string) => {
    useAuthStore.setState((state) => ({
      user: state.user ? { ...state.user, name } : null,
    }));
  });
  useAuthStore.setState({
    user: {
      id: "user-1",
      name: "Bruno Example",
      email: profileEmail,
      avatar: null,
      type: "human",
    },
    token: "better-auth-session",
    loading: false,
    updateName: updateNameMock,
  });
});

describe("SettingsRoute", () => {
  it("keeps the name editable and presents immutable account information", () => {
    render(<SettingsRoute />);

    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.queryByText("Editable name")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Bruno Example");
    expect(screen.getByLabelText("Name")).not.toHaveAttribute("readonly");
    expect(
      screen.queryByRole("textbox", { name: "Email address" }),
    ).not.toBeInTheDocument();
    const email = screen.getByText(profileEmail);
    expect(email.tagName).toBe("DD");
    expect(email).toHaveClass("break-all");
    expect(screen.getByText("Read only")).toBeInTheDocument();
    expect(screen.getByText("User ID")).toBeInTheDocument();
    expect(screen.getByText("user-1").tagName).toBe("DD");
    expect(
      screen.queryByText(/Your display name appears across TheChat/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it("saves a changed name and reflects the returned profile", async () => {
    const user = userEvent.setup();
    render(<SettingsRoute />);

    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Bruno Updated");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(updateNameMock).toHaveBeenCalledWith("Bruno Updated");
    expect(await screen.findByRole("status")).toHaveTextContent("Name saved.");
    expect(screen.getByText("Bruno Updated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it("shows a retryable error without replacing the current profile", async () => {
    updateNameMock.mockRejectedValueOnce(new Error("Could not update profile"));
    const user = userEvent.setup();
    render(<SettingsRoute />);

    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Failed Update");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not update profile",
    );
    expect(screen.getByText("Bruno Example")).toBeInTheDocument();
    expect(nameInput).toHaveValue("Failed Update");
    expect(screen.getByRole("button", { name: "Save name" })).toBeEnabled();
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
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("handles a missing cached user without falling back to local Agent Chat settings", () => {
    useAuthStore.setState({ user: null, token: null, loading: false });

    render(<SettingsRoute />);

    expect(screen.getByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByText("Sign in to view your profile")).toBeInTheDocument();
    expect(screen.queryByText("Provider", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save name" })).not.toBeInTheDocument();
  });
});
