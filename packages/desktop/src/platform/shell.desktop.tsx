import { useEffect } from "react";
import { useToolsStore } from "../stores/tools";
import { initializeDesktopStartup, syncAgentChatMcpAuth } from "../desktop-lifecycle";
import { PermissionModePicker } from "../PermissionModePicker";
import { CodexAuthModal } from "../components/CodexAuthModal";
import { McpConfigDialog } from "../McpConfigDialog";
export { WindowTitlebar as PlatformTitlebar } from "../components/WindowTitlebar";
export { SidebarUpdate as PlatformSidebarUpdate } from "../components/SidebarUpdate";
export { UpdateToast as PlatformUpdateToast } from "../components/UpdateToast";
export function usePlatformLifecycle(token: string | null) {
  const tools = useToolsStore(s => s.tools);
  useEffect(() => initializeDesktopStartup(), []);
  useEffect(() => syncAgentChatMcpAuth(token), [token]);
  useEffect(() => { useToolsStore.getState().initializeTaskRunner(); }, [tools]);
}
export function PlatformDialogs() {
  return <><PermissionModePicker /><CodexAuthModal /><McpConfigDialog /></>;
}

export function PlatformNotificationSettings() { return null; }
