import { useAuthStore } from "./stores/auth";
import { useCodexAuthStore } from "./stores/codex-auth";
import { useConversationsStore } from "./stores/conversations";
import { useFontSizeStore } from "./stores/font-size";
import { useToolsStore } from "./stores/tools";
import { useUpdaterStore } from "./stores/updater";
import { info as logInfo } from "./log";

let agentChatMcpInitialized = false;
let agentChatRouteLeases = 0;
let agentChatMcpActive = false;
let lastAgentChatToken: string | null | undefined;
let pendingAgentChatDeactivation: ReturnType<typeof setTimeout> | null = null;

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

/**
 * Acquire Agent Chat's explicit MCP lifecycle lease.
 *
 * Global MCP setup is one-shot for the frontend session. Authenticated clients are
 * cleared after the final route lease is released. Deferring that release by one
 * task lets React StrictMode's setup-cleanup-setup probe reuse the same lease.
 */
export function activateAgentChatMcp(token: string | null): () => void {
  if (pendingAgentChatDeactivation) {
    clearTimeout(pendingAgentChatDeactivation);
    pendingAgentChatDeactivation = null;
  }

  agentChatRouteLeases += 1;
  agentChatMcpActive = true;

  if (!agentChatMcpInitialized) {
    agentChatMcpInitialized = true;
    void useToolsStore.getState().initializeMcp();
  }

  syncAgentChatMcpAuth(token);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    agentChatRouteLeases = Math.max(0, agentChatRouteLeases - 1);
    if (agentChatRouteLeases > 0) return;

    pendingAgentChatDeactivation = setTimeout(() => {
      pendingAgentChatDeactivation = null;
      if (agentChatRouteLeases > 0) return;

      agentChatMcpActive = false;
      const hadAuthenticatedClient = lastAgentChatToken !== null && lastAgentChatToken !== undefined;
      lastAgentChatToken = undefined;
      if (hadAuthenticatedClient) {
        void useToolsStore.getState().initializeAuthMcp(null);
      }
    }, 0);
  };
}

/** Refresh or clear Agent Chat auth only after its explicit activation. */
export function syncAgentChatMcpAuth(token: string | null): void {
  if (!agentChatMcpActive || token === lastAgentChatToken) return;

  lastAgentChatToken = token;
  void useToolsStore.getState().initializeAuthMcp(token);
}
