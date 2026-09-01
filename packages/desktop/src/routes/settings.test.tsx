import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAuthStore } from "../stores/auth";
import { SettingsRoute } from "./settings";

const {
  invokeMock,
  listTokensMock,
  createTokenMock,
  tokenEndpointMock,
  revokeTokenMock,
  preparePictureMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listTokensMock: vi.fn(),
  createTokenMock: vi.fn(),
  tokenEndpointMock: vi.fn(),
  revokeTokenMock: vi.fn(),
  preparePictureMock: vi.fn(),
}));
const updateNameMock = vi.fn();
const updateAvatarMock = vi.fn();
const profileEmail =
  "bruno.with.a.long.profile.address@example-organization.ch";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../lib/api", () => {
  const personalAccessTokens = Object.assign(
    (...args: unknown[]) => tokenEndpointMock(...args),
    {
      get: listTokensMock,
      post: createTokenMock,
    },
  );
  return {
    API_URL: "https://api.example.test",
    api: {
      auth: {
        "personal-access-tokens": personalAccessTokens,
      },
    },
  };
});

vi.mock("../lib/profile-picture", () => ({
  prepareProfilePicture: preparePictureMock,
}));

beforeEach(() => {
  invokeMock.mockClear();
  updateNameMock.mockReset();
  updateAvatarMock.mockReset();
  preparePictureMock.mockReset();
  listTokensMock.mockReset();
  createTokenMock.mockReset();
  tokenEndpointMock.mockReset();
  revokeTokenMock.mockReset();
  listTokensMock.mockResolvedValue({
    data: { personalAccessTokens: [] },
    error: null,
  });
  tokenEndpointMock.mockReturnValue({ delete: revokeTokenMock });
  revokeTokenMock.mockResolvedValue({ data: { success: true }, error: null });
  updateNameMock.mockImplementation(async (name: string) => {
    useAuthStore.setState((state) => ({
      user: state.user ? { ...state.user, name } : null,
    }));
  });
  updateAvatarMock.mockImplementation(async (avatar: string | null) => {
    useAuthStore.setState((state) => ({
      user: state.user ? { ...state.user, avatar } : null,
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
    updateAvatar: updateAvatarMock,
  });
});

describe("SettingsRoute", () => {
  it("keeps the name editable and presents immutable account information", async () => {
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
    expect(
      await screen.findByText("No personal access tokens yet."),
    ).toBeInTheDocument();
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

  it("uploads, previews, and removes a profile picture", async () => {
    const user = userEvent.setup();
    const avatar = "data:image/jpeg;base64,cHJvZmlsZQ==";
    preparePictureMock.mockResolvedValueOnce(avatar);
    render(<SettingsRoute />);

    expect(
      screen.getAllByRole("img", { name: "Bruno Example profile picture" }),
    ).toHaveLength(2);
    for (const fallback of screen.getAllByRole("img", {
      name: "Bruno Example profile picture",
    })) {
      expect(fallback).toHaveTextContent("BE");
    }
    expect(screen.getByText("Choose picture")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove picture" }),
    ).not.toBeInTheDocument();

    const file = new File(["source"], "portrait.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("Choose profile picture"), file);

    expect(preparePictureMock).toHaveBeenCalledWith(file);
    expect(updateAvatarMock).toHaveBeenCalledWith(avatar);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Profile picture saved.",
    );
    for (const image of screen.getAllByRole("img", {
      name: "Bruno Example profile picture",
    })) {
      expect(image).toHaveAttribute("src", avatar);
    }
    expect(screen.getByText("Change picture")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove picture" }));
    expect(updateAvatarMock).toHaveBeenLastCalledWith(null);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Profile picture removed.",
    );
    for (const fallback of screen.getAllByRole("img", {
      name: "Bruno Example profile picture",
    })) {
      expect(fallback).toHaveTextContent("BE");
    }
  });

  it("does not apply a picture prepared for a previous signed-in account", async () => {
    const user = userEvent.setup();
    let resolvePicture!: (avatar: string) => void;
    preparePictureMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolvePicture = resolve;
      }),
    );
    const updateAvatar = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ updateAvatar });
    render(<SettingsRoute />);

    await user.upload(
      screen.getByLabelText("Choose profile picture"),
      new File(["portrait"], "portrait.png", { type: "image/png" }),
    );
    await waitFor(() => expect(preparePictureMock).toHaveBeenCalledOnce());

    act(() => {
      useAuthStore.setState({
        user: {
          id: "account-2",
          name: "Second Account",
          email: "second@example.com",
          type: "human",
          avatar: null,
        },
      });
      resolvePicture("data:image/jpeg;base64,c3RhbGU=");
    });

    await screen.findByText("Second Account");
    await waitFor(() => expect(updateAvatar).not.toHaveBeenCalled());
    expect(screen.queryByText("Profile picture saved.")).not.toBeInTheDocument();
  });

  it("shows profile-picture processing errors without changing the profile", async () => {
    preparePictureMock.mockRejectedValueOnce(
      new Error("Choose a PNG, JPEG, or WebP image"),
    );
    const user = userEvent.setup({ applyAccept: false });
    render(<SettingsRoute />);

    await user.upload(
      screen.getByLabelText("Choose profile picture"),
      new File(["<svg/>"], "portrait.svg", { type: "image/svg+xml" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a PNG, JPEG, or WebP image",
    );
    expect(updateAvatarMock).not.toHaveBeenCalled();
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

  it("shows API access without restoring unrelated Agent Chat settings", async () => {
    render(<SettingsRoute />);

    expect(
      screen.getByRole("heading", { name: "API access" }),
    ).toBeInTheDocument();
    expect(screen.getByText("REST")).toBeInTheDocument();
    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/api\.example\.test\/auth\/me/)).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/api\.example\.test\/mcp/)).toBeInTheDocument();

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
      "OAuth",
      "Scopes",
    ]) {
      expect(screen.queryByText(removedLabel, { exact: false })).not.toBeInTheDocument();
    }
    expect(
      await screen.findByText("No personal access tokens yet."),
    ).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("creates, reveals, copies, lists, and revokes named personal access tokens", async () => {
    const existing = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Existing CLI",
      start: "tchat_pat_abcd12",
      createdAt: "2026-08-17T10:00:00.000Z",
      lastUsedAt: null,
    };
    const created = {
      id: "00000000-0000-4000-8000-000000000002",
      name: "MCP laptop",
      start: "tchat_pat_efgh34",
      createdAt: "2026-08-18T10:00:00.000Z",
      lastUsedAt: null,
    };
    const rawToken = "tchat_pat_one_time_secret_value";
    listTokensMock.mockResolvedValueOnce({
      data: { personalAccessTokens: [existing] },
      error: null,
    });
    createTokenMock.mockResolvedValueOnce({
      data: { token: rawToken, personalAccessToken: created },
      error: null,
    });
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    render(<SettingsRoute />);

    expect(await screen.findByText("Existing CLI")).toBeInTheDocument();
    const existingToken = screen.getByRole("listitem", {
      name: "Existing CLI personal access token",
    });
    expect(within(existingToken).getByText("Active")).toBeInTheDocument();
    expect(within(existingToken).getByText("Created")).toBeInTheDocument();
    expect(within(existingToken).getByText("Last used")).toBeInTheDocument();
    expect(within(existingToken).getByText("Never")).toBeInTheDocument();
    expect(within(existingToken).getByText("tchat_pat_abcd12…")).toBeInTheDocument();
    expect(screen.queryByText(rawToken)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Token name"), "  MCP laptop  ");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    expect(createTokenMock).toHaveBeenCalledWith(
      { name: "MCP laptop" },
      { headers: { authorization: "Bearer better-auth-session" } },
    );
    expect(await screen.findByDisplayValue(rawToken)).toBeInTheDocument();
    expect(
      screen.getByText(/only time TheChat will return the complete token/i),
    ).toBeInTheDocument();
    expect(screen.getByText("MCP laptop")).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(rawToken)).length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("button", { name: "Copy personal access token" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(rawToken));

    await user.click(screen.getByRole("button", { name: "Copy REST curl snippet" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("https://api.example.test/auth/me"),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Copy MCP JSON snippet" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("https://api.example.test/mcp"),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Revoke Existing CLI" }));
    await user.click(screen.getByRole("button", { name: "Revoke Existing CLI" }));
    await waitFor(() =>
      expect(tokenEndpointMock).toHaveBeenCalledWith({ tokenId: existing.id }),
    );
    expect(revokeTokenMock).toHaveBeenCalledWith(undefined, {
      headers: { authorization: "Bearer better-auth-session" },
    });
    await waitFor(() =>
      expect(screen.queryByText("Existing CLI")).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Hide token" }));
    expect(screen.queryByDisplayValue(rawToken)).not.toBeInTheDocument();
    expect(screen.getAllByText(/<YOUR_PERSONAL_ACCESS_TOKEN>/).length).toBe(2);
  });

  it("never reveals a delayed token response after the signed-in account changes", async () => {
    let resolveCreate!: (value: {
      data: {
        token: string;
        personalAccessToken: {
          id: string;
          name: string;
          start: string;
          createdAt: string;
          lastUsedAt: null;
        };
      };
      error: null;
    }) => void;
    createTokenMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<SettingsRoute />);
    expect(
      await screen.findByText("No personal access tokens yet."),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Token name"), "Account A token");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    act(() => {
      useAuthStore.setState({
        token: "session-token-b",
        loading: false,
        user: {
          id: "user-b",
          email: "other@example.com",
          name: "Other User",
          type: "human",
          avatar: null,
        },
      });
    });
    expect(await screen.findByDisplayValue("Other User")).toBeInTheDocument();

    await act(async () => {
      resolveCreate({
        data: {
          token: "tchat_pat_must-not-render",
          personalAccessToken: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Account A token",
            start: "tchat_pat_mustno",
            createdAt: "2026-08-18T08:00:00.000Z",
            lastUsedAt: null,
          },
        },
        error: null,
      });
      await Promise.resolve();
    });

    expect(
      screen.queryByText("tchat_pat_must-not-render", { exact: false }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Copy Account A token now")).not.toBeInTheDocument();
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
