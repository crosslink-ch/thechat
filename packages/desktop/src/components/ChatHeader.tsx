import { create } from "zustand";
import { useMatches } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AcpCapabilities,
  AcpProfile,
} from "@thechat/shared";
import type { AcpEventState } from "../acp/event-reducer";
import { useWorkspacesStore } from "../stores/workspaces";
import { usePermissionModeStore } from "../stores/permission-mode";
import { AgentProfilePicker } from "./AgentProfilePicker";

// Small route-to-shell stores keep the root header independent of route rendering.
const useAgentChatTitle = create(() => ({
  title: "",
  projectDir: null as string | null,
}));
export const setAgentChatTitle = (title: string) =>
  useAgentChatTitle.setState({ title });
export const setAgentChatProjectDir = (projectDir: string | null) =>
  useAgentChatTitle.setState({ projectDir });
export const getAgentChatProjectDir = () =>
  useAgentChatTitle.getState().projectDir;

export interface AgentChatHeaderContext {
  profiles: AcpProfile[];
  selectedProfileId: string | null;
  profileLocked: boolean;
  projectDir: string | null;
  projectLocked: boolean;
  status: AcpEventState["status"];
  capabilities: AcpCapabilities | null;
  onSelectProfile: (profileId: string | null) => void;
  onSelectProject: (projectDir: string | null) => void;
}

const useAgentChatHeaderContext = create<{
  context: AgentChatHeaderContext | null;
}>(() => ({ context: null }));

export const setAgentChatHeaderContext = (
  context: AgentChatHeaderContext | null,
) => useAgentChatHeaderContext.setState({ context });

export function ChatHeader() {
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const permissionMode = usePermissionModeStore((s) => s.mode);
  const agentTitle = useAgentChatTitle();
  const agentContext = useAgentChatHeaderContext((state) => state.context);
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const routePath = lastMatch?.fullPath ?? "";
  const params = (lastMatch?.params ?? {}) as Record<string, string>;

  const isChannel = routePath.startsWith("/channel");
  const isDm = routePath.startsWith("/dm");
  const isAgentChat = routePath.startsWith("/chat");
  const isSettings = routePath === "/settings";
  const isWorkspaceHome = routePath === "/";
  const isWorkspaceManage = routePath === "/workspace/manage";
  const isBotsManage = routePath === "/bots/manage";
  const isNotifications = routePath === "/notifications";

  let chatTitle = "Workspace";
  if (isSettings) {
    chatTitle = "Settings";
  } else if (isWorkspaceManage) {
    chatTitle = activeWorkspace?.name ?? "Workspace";
  } else if (isBotsManage) {
    chatTitle = "Bots";
  } else if (isNotifications) {
    chatTitle = "Notifications";
  } else if (isChannel) {
    const channelId = params.id;
    const channel = activeWorkspace?.channels.find((ch) => ch.id === channelId);
    chatTitle = channel ? `# ${channel.name}` : "# Channel";
  } else if (isDm) {
    chatTitle = "Direct Message";
  } else if (isAgentChat) {
    chatTitle = agentTitle.title || "Agent Chat";
  }

  const showBackButton = !isWorkspaceHome;
  const projectDir = agentContext?.projectDir ?? agentTitle.projectDir;

  const chooseProject = async () => {
    if (!agentContext || agentContext.projectLocked) return;
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") agentContext.onSelectProject(selected);
  };

  return (
    <div className="flex min-h-12 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface px-3 py-1">
      {showBackButton && (
        <button
          aria-label="Back"
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-none text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
          onClick={() => window.history.back()}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 3L5 7.5L9 12" />
          </svg>
        </button>
      )}
      <span className="min-w-20 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.929rem] text-text-muted">
        {chatTitle}
      </span>

      {isAgentChat && agentContext && (
        <>
          <AgentProfilePicker
            profiles={agentContext.profiles}
            value={agentContext.selectedProfileId}
            onChange={agentContext.onSelectProfile}
            locked={agentContext.profileLocked}
            compact
          />
          <button
            type="button"
            aria-label={`Project: ${projectDir ?? "none selected"}`}
            title={projectDir ?? "Choose project"}
            disabled={agentContext.projectLocked}
            onClick={() => void chooseProject()}
            className="h-8 max-w-40 truncate rounded-md border border-border bg-raised px-2 text-[0.786rem] text-text-secondary disabled:cursor-default disabled:opacity-70"
          >
            {projectDir ? lastPathSegment(projectDir) : "Choose project"}
          </button>
          <span
            role="status"
            aria-live="polite"
            className="rounded-md border border-border-subtle bg-base px-2 py-1 text-[0.714rem] font-medium text-text-muted"
          >
            {statusLabel(agentContext.status)}
          </span>
          {agentContext.capabilities?.loadSession && (
            <CapabilityChip label="Session resume" />
          )}
          {agentContext.capabilities?.prompt?.image && (
            <CapabilityChip label="Images" />
          )}
          {agentContext.capabilities?.prompt?.audio && (
            <CapabilityChip label="Audio" />
          )}
          {agentContext.capabilities?.prompt?.embeddedContext && (
            <CapabilityChip label="Embedded context" />
          )}
          {agentContext.capabilities?.modes && (
            <CapabilityChip label="Modes" />
          )}
          {agentContext.capabilities?.configOptions && (
            <CapabilityChip label="Config options" />
          )}
          {agentContext.capabilities?.plans && (
            <CapabilityChip label="Plans" />
          )}
        </>
      )}

      {isAgentChat && permissionMode === "allow-edits" && (
        <span className="rounded-md bg-warning-bg px-2 py-0.5 text-[0.786rem] font-medium text-warning-text">
          Allow Edits
        </span>
      )}
      {isAgentChat && permissionMode === "bypass" && (
        <span className="rounded-md bg-danger-bg px-2 py-0.5 text-[0.786rem] font-medium text-error-bright">
          Bypass
        </span>
      )}
    </div>
  );
}

function CapabilityChip({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <span
      className={`hidden rounded px-1.5 py-0.5 text-[0.643rem] xl:inline ${
        muted
          ? "bg-warning-bg text-warning-text"
          : "bg-success/10 text-success"
      }`}
    >
      {label}
    </span>
  );
}

function statusLabel(status: AcpEventState["status"]) {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function lastPathSegment(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}
