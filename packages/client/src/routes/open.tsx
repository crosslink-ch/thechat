import { useEffect, useRef } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";

export interface OpenConversationSearch {
  conversationId?: string;
  type?: "direct" | "group";
  workspaceId?: string;
  threadId?: string;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function id(value: unknown) {
  return typeof value === "string" && ID.test(value) ? value : undefined;
}

export function validateOpenSearch(search: Record<string, unknown>): OpenConversationSearch {
  return {
    conversationId: id(search.conversationId),
    type: search.type === "direct" || search.type === "group" ? search.type : undefined,
    workspaceId: id(search.workspaceId),
    threadId: id(search.threadId),
  };
}

/**
 * Landing route for a tapped notification: switch to the conversation's
 * workspace first, then open the conversation (and thread).
 */
export function OpenConversationRoute() {
  const search = useSearch({ strict: false }) as OpenConversationSearch;
  const navigate = useNavigate();
  const signedIn = useAuthStore((state) => Boolean(state.user));
  const activeWorkspaceId = useWorkspacesStore((state) => state.activeWorkspace?.id ?? null);
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    const key = JSON.stringify(search);
    if (started.current === key) return;
    started.current = key;
    const { conversationId, type, workspaceId, threadId } = search;
    void (async () => {
      if (workspaceId && workspaceId !== activeWorkspaceId) {
        await useWorkspacesStore.getState().selectWorkspace(workspaceId);
      }
      if (!conversationId || !type) {
        await navigate({ to: "/activity", replace: true });
      } else if (type === "group") {
        await navigate({ to: "/channel/$id", params: { id: conversationId }, replace: true });
      } else {
        await navigate({
          to: "/dm/$id",
          params: { id: conversationId },
          search: { threadId },
          replace: true,
        });
      }
    })();
  }, [activeWorkspaceId, navigate, search, signedIn]);

  return (
    <div className="flex h-full items-center justify-center text-[0.929rem] text-text-dimmed">
      Opening conversation…
    </div>
  );
}
