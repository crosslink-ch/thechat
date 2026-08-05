import { useAuthStore } from "./stores/auth";
import { useCodexAuthStore } from "./stores/codex-auth";
import { useConversationsStore } from "./stores/conversations";
import { useFontSizeStore } from "./stores/font-size";
import { useToolsStore } from "./stores/tools";
import { useUpdaterStore } from "./stores/updater";
import { info as logInfo } from "./log";

/** Initialize integrations required by the normal desktop experience. */
export function initializeDesktopStartup(): () => void {
  logInfo("[root] Initializing app");
  void useAuthStore.getState().initialize();
  void useToolsStore.getState().discoverSkills();
  void useCodexAuthStore.getState().initialize();
  void useConversationsStore.getState().fetchConversations();
  useFontSizeStore.getState().initialize();
  void useUpdaterStore.getState().checkForUpdates();

  return () => {
    void useUpdaterStore.getState().reset();
  };
}

/** Start Agent Chat's unauthenticated MCP integrations on explicit route use. */
export function activateAgentChatMcp(): void {
  useToolsStore.getState().initializeMcp();
}

/** Start or refresh Agent Chat's authenticated MCP integrations on explicit route use. */
export function syncAgentChatMcpAuth(token: string | null): void {
  if (token) {
    useToolsStore.getState().initializeAuthMcp(token);
  }
}
