import { create } from "zustand";
import type { SearchDestination } from "@thechat/shared";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import { useSearchDirectoryStore } from "../stores/search-directory";
import { requestInputBarFocus } from "../stores/input-focus";
import { openDirectConversationId } from "./search-api";

export interface SearchLocation {
  workspaceId: string;
  conversationId: string;
  conversationType: "direct" | "group";
  /** A Hermes task; null or absent opens General / the whole channel. */
  threadId?: string | null;
}

/**
 * Bumped on every jump into a DM. The DM view re-applies the requested task
 * even when the URL did not change, so jumping to "Koda" from one of Koda's
 * tasks lands on General.
 */
export const useLocationJumpStore = create(() => ({
  nonce: 0,
  conversationId: null as string | null,
}));

type Navigate = (options: {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string | undefined>;
  replace?: boolean;
}) => unknown;

let navigateImpl: Navigate | null = null;

/** The root layout hands over the router's navigate (keeps this module router-free). */
export function registerSearchNavigator(navigate: Navigate) {
  navigateImpl = navigate;
  return () => {
    if (navigateImpl === navigate) navigateImpl = null;
  };
}

export async function searchNavigate(options: Parameters<Navigate>[0]) {
  if (!navigateImpl) throw new Error("The app is still starting");
  await navigateImpl(options);
}

let jumpGeneration = 0;

/** A later jump supersedes an earlier one that is still switching workspace. */
export class JumpSupersededError extends Error {
  constructor() {
    super("Superseded by a newer jump");
  }
}

async function enterWorkspace(workspaceId: string, generation: number) {
  const workspaces = useWorkspacesStore.getState();
  if (workspaces.activeWorkspace?.id !== workspaceId) {
    const selected = await workspaces.selectWorkspace(workspaceId);
    if (generation !== jumpGeneration) throw new JumpSupersededError();
    if (!selected) throw new Error("Could not open that workspace");
  }
}

/** Open a conversation (or task) in any of the user's workspaces. */
export async function openSearchLocation(location: SearchLocation) {
  const generation = ++jumpGeneration;
  await enterWorkspace(location.workspaceId, generation);
  if (location.conversationType === "group") {
    useConversationsStore.getState().markChannelRead(location.conversationId);
    await searchNavigate({ to: "/channel/$id", params: { id: location.conversationId } });
  } else {
    await searchNavigate({
      to: "/dm/$id",
      params: { id: location.conversationId },
      search: { threadId: location.threadId ?? undefined },
    });
    useLocationJumpStore.setState((state) => ({
      nonce: state.nonce + 1,
      conversationId: location.conversationId,
    }));
  }
  if (generation !== jumpGeneration) throw new JumpSupersededError();
  requestInputBarFocus();
}

/** Open a quick-switcher destination, creating the DM with a person on first use. */
export async function openSearchDestination(destination: SearchDestination) {
  switch (destination.kind) {
    case "channel":
      return openSearchLocation({
        workspaceId: destination.workspaceId,
        conversationId: destination.conversationId,
        conversationType: "group",
      });
    case "task":
      return openSearchLocation({
        workspaceId: destination.workspaceId,
        conversationId: destination.conversationId,
        conversationType: "direct",
        threadId: destination.threadId,
      });
    case "person": {
      let conversationId = destination.conversationId;
      if (!conversationId) {
        const generation = jumpGeneration;
        conversationId = await openDirectConversationId(destination.workspaceId, destination.userId);
        if (generation !== jumpGeneration) throw new JumpSupersededError();
        useSearchDirectoryStore
          .getState()
          .rememberDirectConversation(destination.workspaceId, destination.userId, conversationId);
      }
      if (destination.workspaceId === useWorkspacesStore.getState().activeWorkspace?.id) {
        useConversationsStore.getState().rememberDirectConversation(destination.userId, conversationId);
      }
      return openSearchLocation({
        workspaceId: destination.workspaceId,
        conversationId,
        conversationType: "direct",
      });
    }
  }
}

/** Show one message in context (switching to its workspace first). */
export async function openSearchMessage(hit: { id: string; workspaceId: string }) {
  const generation = ++jumpGeneration;
  await enterWorkspace(hit.workspaceId, generation);
  await searchNavigate({ to: "/message/$messageId", params: { messageId: hit.id } });
}
