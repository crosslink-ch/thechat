import { useNavigate } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { sessionGeneration } from "../lib/session-boundary";
import { requestInputBarFocus } from "../stores/input-focus";
import type { SearchDestination, SearchMessageResult } from "@thechat/shared";

/** Route only after authorized workspace selection succeeds and this action still owns the UI. */
export function useSearchNavigation() {
  const navigate = useNavigate();
  return async (
    item: SearchDestination | SearchMessageResult,
    isCurrent: () => boolean = () => true,
  ) => {
    const auth = useAuthStore.getState();
    const generation = sessionGeneration();
    const current = () =>
      isCurrent() &&
      sessionGeneration() === generation &&
      useAuthStore.getState().user?.id === auth.user?.id &&
      useAuthStore.getState().token === auth.token;
    if (!current()) return false;
    const workspaces = useWorkspacesStore.getState();
    if (workspaces.activeWorkspace?.id !== item.workspaceId) {
      const selected = await workspaces.selectWorkspace(item.workspaceId, current);
      if (!current()) return false;
      if (!selected)
        throw new Error(
          `Could not open ${item.workspaceName}. Check your access and try again.`,
        );
    }
    if (!current()) return false;
    const isMessage = "content" in item;
    await navigate({
      to: item.conversationType === "group"
        ? "/channel/$id"
        : "/dm/$id",
      params: { id: item.conversationId },
      search: {
        threadId: item.threadId ?? undefined,
        messageId: isMessage ? item.id : undefined,
        jump: crypto.randomUUID(),
      },
    });
    if (current()) requestInputBarFocus();
    return true;
  };
}
