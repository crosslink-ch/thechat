import type { useNavigate } from "@tanstack/react-router";
import { useWorkspacesStore } from "../stores/workspaces";
import { useThreadPanelStore } from "../stores/thread-panel";

type Navigate = ReturnType<typeof useNavigate>;

/** Where a reply thread lives and, optionally, which reply to highlight. */
export interface ReplyThreadLocation {
  workspaceId: string;
  workspaceName?: string;
  conversationId: string;
  conversationType: "direct" | "group";
  rootMessageId: string;
  highlightMessageId?: string | null;
}

/**
 * Opens a reply thread from anywhere (Activity, Threads, search): switches
 * workspace when needed, opens the conversation and its thread side panel.
 */
export async function openReplyThread(navigate: Navigate, location: ReplyThreadLocation) {
  const workspaces = useWorkspacesStore.getState();
  if (workspaces.activeWorkspace?.id !== location.workspaceId) {
    const selected = await workspaces.selectWorkspace(location.workspaceId);
    if (!selected) {
      throw new Error(`Couldn't open ${location.workspaceName ?? "that workspace"}`);
    }
  }
  // Opening through the store first avoids a flash of the panel-less view;
  // the search parameters keep the link shareable and survive reloads.
  useThreadPanelStore.getState().openThread(location.conversationId, location.rootMessageId, {
    highlightMessageId: location.highlightMessageId ?? null,
  });
  const search = {
    replyThread: location.rootMessageId,
    ...(location.highlightMessageId ? { replyMessage: location.highlightMessageId } : {}),
  };
  if (location.conversationType === "group") {
    await navigate({ to: "/channel/$id", params: { id: location.conversationId }, search });
  } else {
    await navigate({
      to: "/dm/$id",
      params: { id: location.conversationId },
      search: { threadId: undefined, ...search },
    });
  }
}
