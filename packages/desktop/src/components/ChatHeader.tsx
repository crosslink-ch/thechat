import { create } from "zustand";
import { useMatches } from "@tanstack/react-router";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { toggleSidebar } from "./Sidebar";

// Mini-store for agent chat title (set by agent-chat route)
const useAgentChatTitle = create(() => ({ title: "" }));
export const setAgentChatTitle = (title: string) =>
  useAgentChatTitle.setState({ title });

export function ChatHeader() {
  const connected = useWebSocketStore((s) => s.connected);
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);
  const agentChatTitle = useAgentChatTitle((s) => s.title);
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const routePath = lastMatch?.fullPath ?? "";
  const params = (lastMatch?.params ?? {}) as Record<string, string>;

  const isAgentChat = routePath.startsWith("/chat");
  const isChannel = routePath.startsWith("/channel");
  const isDm = routePath.startsWith("/dm");

  let chatTitle = "New Chat";
  if (isAgentChat) {
    chatTitle = agentChatTitle || "New Chat";
  } else if (isChannel) {
    const channelId = params.id;
    const channel = activeWorkspace?.channels.find((ch) => ch.id === channelId);
    chatTitle = channel ? `# ${channel.name}` : "# Channel";
  } else if (isDm) {
    chatTitle = "Direct Message";
  }

  const showBackButton = !isAgentChat;
  const showWsStatus = !isAgentChat && connected;

  return (
    <div className="chat-header">
      <button className="menu-btn" onClick={toggleSidebar}>
        &#9776;
      </button>
      {showBackButton && (
        <button className="back-btn" onClick={() => window.history.back()}>
          &larr;
        </button>
      )}
      <span className="chat-title">{chatTitle}</span>
      {showWsStatus && <span className="ws-status ws-connected" />}
    </div>
  );
}
