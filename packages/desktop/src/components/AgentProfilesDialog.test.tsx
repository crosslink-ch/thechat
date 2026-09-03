import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpProfile, AppConfig } from "@thechat/shared";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { AgentProfilesSettings } from "./AgentProfilesDialog";

const baseConfig: AppConfig = {
  api_key: "",
  providers: {
    openrouter: { model: "model" },
    codex: { model: "model" },
    glm: { model: "model" },
    featherless: { model: "model" },
  },
  acpProfiles: [],
  defaultAcpProfileId: null,
};

function profile(overrides: Partial<AcpProfile> = {}): AcpProfile {
  return {
    id: "profile-codex",
    name: "Codex",
    executable: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.7.0"],
    inheritEnv: [],
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_config") return structuredClone(baseConfig);
    if (command === "save_config") return undefined;
    throw new Error(`Unexpected command ${command}`);
  });
});

describe("AgentProfilesSettings", () => {
  it("offers exactly pinned Codex, Claude, and OpenCode templates with security copy", async () => {
    const user = userEvent.setup();
    render(<AgentProfilesSettings />);

    expect(await screen.findByRole("heading", { name: "Agent profiles" })).toBeInTheDocument();
    expect(screen.getByText(/approvals are cooperative controls, not an OS sandbox/i)).toBeInTheDocument();
    expect(screen.getByText(/runs with your desktop user's OS identity/i)).toBeInTheDocument();
    expect(screen.getByText(/environment variable names only/i)).toBeInTheDocument();
    expect(screen.getByText(/npx templates may download packages on first run/i)).toBeInTheDocument();

    expect(screen.getByText("npx -y @agentclientprotocol/codex-acp@1.7.0")).toBeInTheDocument();
    expect(screen.getByText("npx -y @agentclientprotocol/claude-agent-acp@0.70.0")).toBeInTheDocument();
    expect(screen.getByText("opencode acp")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add Codex template" }));
    expect(screen.getByLabelText("Profile name")).toHaveValue("Codex");
    expect(screen.getByLabelText("Executable")).toHaveValue("npx");
    expect(screen.getByLabelText("Argument 1")).toHaveValue("-y");
    expect(screen.getByLabelText("Argument 2")).toHaveValue(
      "@agentclientprotocol/codex-acp@1.7.0",
    );
  });

  it("saves literal argv and inherited environment names without any secret-value map", async () => {
    const user = userEvent.setup();
    render(<AgentProfilesSettings />);
    await screen.findByRole("heading", { name: "Agent profiles" });

    await user.click(screen.getByRole("button", { name: "Add Claude template" }));
    await user.click(screen.getByRole("button", { name: "Add environment name" }));
    await user.type(screen.getByLabelText("Environment name 1"), "ANTHROPIC_CONFIG_DIR");
    await user.click(screen.getByRole("button", { name: "Save agent profiles" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "save_config",
        expect.objectContaining({
          config: expect.objectContaining({
            defaultAcpProfileId: expect.any(String),
            acpProfiles: [
              expect.objectContaining({
                name: "Claude",
                executable: "npx",
                args: ["-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
                inheritEnv: ["ANTHROPIC_CONFIG_DIR"],
              }),
            ],
          }),
        }),
      ),
    );
    const savePayload = invokeMock.mock.calls.find(
      ([command]) => command === "save_config",
    )?.[1] as { config: AppConfig };
    const serialized = JSON.stringify(savePayload.config.acpProfiles);
    expect(serialized).not.toContain("envValues");
    expect(serialized).not.toContain("fingerprint");
    expect(serialized).not.toContain("secret");
  });

  it("requires explicit duplicate confirmation and keeps the original as default", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_config") {
        return {
          ...structuredClone(baseConfig),
          acpProfiles: [profile()],
          defaultAcpProfileId: "profile-codex",
        };
      }
      if (command === "save_config") return undefined;
      throw new Error(`Unexpected command ${command}`);
    });
    const user = userEvent.setup();
    render(<AgentProfilesSettings />);
    await screen.findByDisplayValue("Codex");

    await user.click(screen.getByRole("button", { name: "Duplicate Codex" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Duplicate Codex?" });
    expect(screen.getAllByLabelText("Profile name")).toHaveLength(1);

    await user.click(within(confirmation).getByRole("button", { name: "Confirm duplicate" }));
    expect(screen.getAllByLabelText("Profile name")).toHaveLength(2);
    expect(screen.getByDisplayValue("Codex copy")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Default Codex" })).toBeChecked();
  });

  it("blocks invalid env-name/value input and moves default away from a disabled profile", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_config") {
        return {
          ...structuredClone(baseConfig),
          acpProfiles: [
            profile(),
            profile({
              id: "profile-opencode",
              name: "OpenCode",
              executable: "opencode",
              args: ["acp"],
            }),
          ],
          defaultAcpProfileId: "profile-codex",
        };
      }
      if (command === "save_config") return undefined;
      throw new Error(`Unexpected command ${command}`);
    });
    const user = userEvent.setup();
    render(<AgentProfilesSettings />);
    await screen.findByDisplayValue("Codex");

    await user.click(screen.getByRole("button", { name: "Add environment name for Codex" }));
    await user.type(screen.getByLabelText("Environment name 1"), "TOKEN=literal-secret");
    expect(screen.getByRole("alert")).toHaveTextContent(
      /environment entries must be variable names only/i,
    );
    expect(screen.getByRole("button", { name: "Save agent profiles" })).toBeDisabled();

    await user.clear(screen.getByLabelText("Environment name 1"));
    await user.type(screen.getByLabelText("Environment name 1"), "PATH");
    await user.click(screen.getByRole("checkbox", { name: "Disable Codex" }));
    expect(screen.getByRole("radio", { name: "Default OpenCode" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save agent profiles" }));
    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([command]) => command === "save_config");
      expect((call?.[1] as { config: AppConfig }).config.defaultAcpProfileId).toBe(
        "profile-opencode",
      );
    });
  });
});
