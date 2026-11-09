import { useCallback, useMemo } from "react";
import { create } from "zustand";
import type { SearchDestination } from "@thechat/shared";
import type { MessageJumpRequest } from "../hooks/useMessageJump";
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
  /** Open the chat scrolled to this message, highlighted for a moment. */
  messageId?: string;
}

/** A message the chat of its conversation opens at. */
export interface PendingMessageJump {
  id: number;
  messageId: string;
  conversationId: string;
  threadId: string | null;
  createdAt: number;
}

/** A jump the user navigated away from before it finished is forgotten after this. */
const MESSAGE_JUMP_TTL_MS = 30_000;

/**
 * `nonce` is bumped on every jump into a DM. The DM view re-applies the
 * requested task even when the URL did not change, so jumping to "Koda" from
 * one of Koda's tasks lands on General.
 *
 * `message` is the message the chat opens at; it stays set until that chat
 * has shown it (or found it out of reach).
 */
export const useLocationJumpStore = create(() => ({
  nonce: 0,
  conversationId: null as string | null,
  message: null as PendingMessageJump | null,
}));

let messageJumpId = 0;

function finishMessageJump(id: number) {
  useLocationJumpStore.setState((state) => (state.message?.id === id ? { message: null } : state));
}

/**
 * The message this chat should open at, if any. `threadId` undefined takes a
 * message from any thread (a channel shows them all); otherwise only from that
 * task (null: General).
 */
export function usePendingMessageJump(conversationId: string, threadId?: string | null) {
  const pending = useLocationJumpStore((state) => {
    const message = state.message;
    if (!message || message.conversationId !== conversationId) return null;
    if (threadId !== undefined && message.threadId !== threadId) return null;
    return message;
  });
  const jump = useMemo<MessageJumpRequest | undefined>(
    () =>
      pending && Date.now() - pending.createdAt < MESSAGE_JUMP_TTL_MS
        ? { messageId: pending.messageId, key: String(pending.id) }
        : undefined,
    [pending],
  );
  const onJumpDone = useCallback(() => {
    if (pending) finishMessageJump(pending.id);
  }, [pending]);
  return { jump, onJumpDone };
}

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

/** Open a conversation (or task) in any of the user's workspaces, optionally at one message. */
export async function openSearchLocation(location: SearchLocation) {
  const generation = ++jumpGeneration;
  await enterWorkspace(location.workspaceId, generation);
  // Set before navigating, so the chat never first shows its latest messages.
  const message = location.messageId
    ? {
        id: ++messageJumpId,
        messageId: location.messageId,
        conversationId: location.conversationId,
        threadId: location.threadId ?? null,
        createdAt: Date.now(),
      }
    : null;
  useLocationJumpStore.setState({ message });
  try {
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
  } catch (error) {
    if (message) finishMessageJump(message.id);
    throw error;
  }
  if (generation !== jumpGeneration) throw new JumpSupersededError();
  // Not when opening at a message: a phone keyboard would cover it.
  if (!message) requestInputBarFocus();
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
