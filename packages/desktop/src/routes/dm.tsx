import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import {
  useBotRuntime,
  useBotRuntimeCache,
  submitHermesInteraction,
} from "../hooks/useBotRuntime";
import type { BotInvocationProgressEventPublic } from "@thechat/shared";
import { useConversationThreads } from "../hooks/useConversationThreads";
import { useConversationDetail } from "../hooks/useConversationDetail";
import { useScopedCommands } from "../hooks/useScopedCommands";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import { composerDraftKey } from "../stores/composer-drafts";
import { useChannelChat } from "../hooks/useChannelChat";
import { ChannelChatView } from "../components/ChannelChatView";
import { HermesDmChatView } from "../components/HermesDmChatView";
import { HermesRuntimePanel } from "../components/HermesRuntimePanel";
import { closePaletteAndRefocus } from "../CommandPalette";
import type { Command } from "../commands";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { selectHermesConversationProgress } from "../lib/hermes-progress";
import {
  decisionFromApprovalCommand,
  pendingApprovalEvents,
} from "../lib/hermes-approvals";
import {
  recordApprovalDecision,
  useHermesApprovalsStore,
} from "../stores/hermes-approvals";
import {
  hermesScopeKey,
  useHermesIndicatorsStore,
} from "../stores/hermes-indicators";
import {
  buildHermesSlashCommands,
  canonicalHermesSlashCommand,
  parseHermesSlashCommand,
} from "../lib/hermes-slash-commands";

const LOCAL_TASK_DRAFT_SCOPE = "__local_task_draft__";

export function DmRoute() {
  const { id: conversationId } = useParams({ from: "/dm/$id" });
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const members = useWorkspacesStore((s) => s.activeWorkspace?.members);
  const wsSendMessage = useWebSocketStore((s) => s.sendMessage);
  const conversationQuery = useConversationDetail(conversationId, token);
  const conversation = conversationQuery.data ?? null;
  const conversationLoading = conversationQuery.isLoading;
  const conversationPending = !conversation && !!token && !conversationQuery.error;

  const mentions = useMemo(
    () =>
      members
        ?.filter((m) => m.userId !== user?.id)
        .map((m) => ({ id: m.userId, label: m.user.name, type: m.user.type })),
    [members, user?.id]
  );

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const otherParticipant = useMemo(
    () => conversation?.participants.find((p) => p.userId !== user?.id) ?? null,
    [conversation, user?.id],
  );
  const isHermesDm = conversation?.type === "direct" && otherParticipant?.bot?.kind === "hermes";
  const registeredBotCommands = otherParticipant?.bot?.commands;
  const slashCommands = useMemo(
    () => buildHermesSlashCommands(registeredBotCommands),
    [registeredBotCommands],
  );
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [draftTaskActive, setDraftTaskActive] = useState(false);
  const [draftSendError, setDraftSendError] = useState<string | null>(null);
  const [draftComposerRevision, setDraftComposerRevision] = useState(0);
  const activeConversationIdRef = useRef(conversationId);
  activeConversationIdRef.current = conversationId;
  const draftPersistingRef = useRef<symbol | null>(null);
  const runtimeQuery = useBotRuntime(conversationId, token, isHermesDm);
  const runtime = runtimeQuery.data ?? null;
  const runtimeLoading = runtimeQuery.isLoading;
  const threadState = useConversationThreads(conversationId, token, isHermesDm);
  const {
    threads,
    loading: threadsLoading,
    loadingMore: threadsLoadingMore,
    hasMore: threadsHasMore,
    loadMore: loadMoreThreads,
    createThread,
    renameThread,
    touchThread,
  } = threadState;
  const { mergeInvocationUpdate, mergeProgressEvent, invalidate } =
    useBotRuntimeCache();
  const generalThreadActive = isHermesDm && !draftTaskActive && activeThreadId === null;
  const generalProgressActive = generalThreadActive;
  const progressThreadId = draftTaskActive ? LOCAL_TASK_DRAFT_SCOPE : activeThreadId;
  const activeHermesProgress = useMemo(
    () =>
      selectHermesConversationProgress(runtime, progressThreadId, {
        unthreadedOnly: generalProgressActive,
      }),
    [generalProgressActive, progressThreadId, runtime],
  );
  const activeHermesProgressRef = useRef(activeHermesProgress);
  activeHermesProgressRef.current = activeHermesProgress;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const chatConversationId = conversation ? conversationId : null;
  const taskActive = activeHermesProgress.taskActive;

  // Attention indicators: which tasks in this DM need approval or finished unread.
  const pendingApprovals = useHermesIndicatorsStore((s) => s.pendingApprovals);
  const pendingClarifications = useHermesIndicatorsStore(
    (state) => state.pendingClarifications,
  );
  const pendingInteractions = useMemo(
    () => [...pendingApprovals, ...pendingClarifications],
    [pendingApprovals, pendingClarifications],
  );
  const unreadScopes = useHermesIndicatorsStore((s) => s.unreadScopes);
  const approvalThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const interaction of pendingInteractions) {
      if (interaction.conversationId !== conversationId) continue;
      if (interaction.threadId) ids.add(interaction.threadId);
    }
    return ids;
  }, [conversationId, pendingInteractions]);
  const generalNeedsApproval = useMemo(
    () =>
      pendingInteractions.some(
        (interaction) =>
          interaction.conversationId === conversationId &&
          interaction.threadId === null,
      ),
    [conversationId, pendingInteractions],
  );
  const unreadThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const scope of Object.values(unreadScopes)) {
      if (scope.conversationId !== conversationId) continue;
      if (scope.threadId) ids.add(scope.threadId);
    }
    return ids;
  }, [conversationId, unreadScopes]);
  const generalUnread = useMemo(
    () =>
      Object.values(unreadScopes).some(
        (scope) => scope.conversationId === conversationId && scope.threadId === null,
      ),
    [conversationId, unreadScopes],
  );

  // Keep the indicators store in sync with what the user is looking at, and
  // seed it from the fetched runtime snapshot so approvals requested before
  // this client connected still show up.
  useEffect(() => {
    if (!isHermesDm) return;
    const store = useHermesIndicatorsStore.getState();
    store.setVisibleScope(
      draftTaskActive ? null : hermesScopeKey(conversationId, activeThreadId),
    );
    return () => {
      useHermesIndicatorsStore.getState().setVisibleScope(null);
    };
  }, [activeThreadId, conversationId, draftTaskActive, isHermesDm]);

  useEffect(() => {
    if (!isHermesDm || !runtime) return;
    useHermesIndicatorsStore
      .getState()
      .seedFromSnapshot(
        conversationId,
        runtime,
        useHermesApprovalsStore.getState().decisions,
      );
  }, [conversationId, isHermesDm, runtime]);

  const channelChat = useChannelChat({
    conversationId: chatConversationId,
    threadId: isHermesDm ? activeThreadId : null,
    unthreadedOnly: generalThreadActive,
    enabled: !draftTaskActive,
    token,
    wsSendMessage,
    selfUser: user,
  });

  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;
  const channelSendMessage = channelChat.sendMessage;
  const channelSendMessageToThread = channelChat.sendMessageToThread;
  const addOptimisticSentMessage = channelChat.addOptimisticSentMessage;

  // Subscribe to WebSocket messages for this DM
  useEffect(() => {
    const onMessage = ({
      message: msg,
      clientMessageId,
    }: WsEvents["ws:new_message"]) => {
      if (msg.conversationId === conversationId) {
        channelChatRef.current.addMessage(msg, clientMessageId);
        if (msg.threadId) {
          touchThread(msg.threadId, msg.createdAt);
        }
        if (!isHermesDm || msg.threadId === activeThreadId) {
          setTypingUsers((prev) => {
            if (!prev.has(msg.senderId)) return prev;
            const next = new Map(prev);
            next.delete(msg.senderId);
            return next;
          });
        }
      }
    };

    const onTyping = ({
      conversationId: convId,
      threadId,
      userId,
      userName,
    }: WsEvents["ws:typing"]) => {
      if (convId !== conversationId) return;
      if (draftTaskActive) return;
      if (isHermesDm && (threadId ?? null) !== activeThreadId) return;

      setTypingUsers((prev) => {
        const next = new Map(prev);
        next.set(userId, userName);
        return next;
      });

      const existing = typingTimers.current.get(userId);
      if (existing) clearTimeout(existing);
      typingTimers.current.set(
        userId,
        setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Map(prev);
            next.delete(userId);
            return next;
          });
          typingTimers.current.delete(userId);
        }, 3000),
      );
    };

    const onBotInvocationUpdated = ({
      conversationId: convId,
      invocation,
    }: WsEvents["ws:bot_invocation_updated"]) => {
      if (convId !== conversationId) return;
      mergeInvocationUpdate(conversationId, invocation);
    };
    const onBotInvocationProgress = ({
      conversationId: convId,
      event,
      invocation,
    }: WsEvents["ws:bot_invocation_progress"]) => {
      if (convId !== conversationId) return;
      mergeProgressEvent(conversationId, event, invocation);
    };

    wsEvents.on("ws:new_message", onMessage);
    wsEvents.on("ws:typing", onTyping);
    wsEvents.on("ws:bot_invocation_updated", onBotInvocationUpdated);
    wsEvents.on("ws:bot_invocation_progress", onBotInvocationProgress);

    return () => {
      wsEvents.off("ws:new_message", onMessage);
      wsEvents.off("ws:typing", onTyping);
      wsEvents.off("ws:bot_invocation_updated", onBotInvocationUpdated);
      wsEvents.off("ws:bot_invocation_progress", onBotInvocationProgress);
      for (const timer of typingTimers.current.values()) {
        clearTimeout(timer);
      }
      typingTimers.current.clear();
    };
  }, [
    activeThreadId,
    conversationId,
    draftTaskActive,
    isHermesDm,
    mergeInvocationUpdate,
    mergeProgressEvent,
    touchThread,
  ]);

  // Clear typing users when the visible DM or Hermes task changes.
  useEffect(() => {
    setTypingUsers(new Map());
    for (const timer of typingTimers.current.values()) {
      clearTimeout(timer);
    }
    typingTimers.current.clear();
  }, [conversationId, activeThreadId, draftTaskActive]);

  // Reset task selection when the visible DM changes.
  useEffect(() => {
    setActiveThreadId(null);
    setDraftTaskActive(false);
    setDraftSendError(null);
    draftPersistingRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    if (!isHermesDm) return;
    if (activeThreadId && !threads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(null);
    }
  }, [activeThreadId, isHermesDm, threads]);

  const handleCreateThread = useCallback(() => {
    if (!isHermesDm || draftPersistingRef.current) return;
    setDraftSendError(null);
    setActiveThreadId(null);
    setDraftTaskActive(true);
    setDraftComposerRevision((revision) => revision + 1);
  }, [isHermesDm]);

  const handleSelectThread = useCallback((threadId: string | null) => {
    if (draftPersistingRef.current) return;
    setDraftSendError(null);
    setDraftTaskActive(false);
    setActiveThreadId(threadId);
  }, []);

  const hermesTaskCommands = useMemo<Command[]>(
    () => [
      {
        id: "hermes.new-task",
        label: "New Task",
        shortcut: "C-x n",
        keybinding: { prefix: "C-x", key: "n" },
        enabled: isHermesDm,
        priority: 100,
        execute: () => {
          handleCreateThread();
          closePaletteAndRefocus();
        },
      },
    ],
    [handleCreateThread, isHermesDm],
  );
  useScopedCommands(hermesTaskCommands);

  const sendHermesMessageNow = useCallback(async (
    content: string,
    threadId: string | null,
    attachmentIds: string[] = [],
  ) => {
    if (threadId !== null) {
      const activeThread = threadsRef.current.find((thread) => thread.id === threadId);
      if (!parseHermesSlashCommand(content) && isAutoNamedThread(activeThread)) {
        try {
          await renameThread(threadId, titleFromMessage(content));
        } catch (error) {
          console.error("Failed to rename Hermes task thread", error);
        }
      }
      touchThread(threadId);
    }
    return channelSendMessageToThread(content, threadId, attachmentIds);
  }, [
    channelSendMessageToThread,
    renameThread,
    touchThread,
  ]);

  const persistDraftAndSend = useCallback(async (
    content: string,
    attachmentIds: string[] = [],
  ) => {
    if (!isHermesDm || draftPersistingRef.current) return false;
    const persistAttempt = Symbol("persist-hermes-task-draft");
    draftPersistingRef.current = persistAttempt;
    setDraftSendError(null);

    try {
      const thread = await createThread({
        botId: otherParticipant?.bot?.id,
        ...(parseHermesSlashCommand(content) ? {} : { title: titleFromMessage(content) }),
      });
      const isCurrentDraft =
        draftPersistingRef.current === persistAttempt &&
        activeConversationIdRef.current === conversationId;
      if (!thread) {
        if (isCurrentDraft) setDraftSendError("Could not create the task. Try again.");
        return false;
      }

      const clientMessageId = isCurrentDraft
        ? addOptimisticSentMessage(content, thread.id)
        : null;
      if (isCurrentDraft) {
        setDraftTaskActive(false);
        setActiveThreadId(thread.id);
      }
      if (attachmentIds.length > 0) {
        wsSendMessage(
          conversationId,
          content,
          thread.id,
          clientMessageId ?? undefined,
          attachmentIds,
        );
      } else {
        wsSendMessage(
          conversationId,
          content,
          thread.id,
          clientMessageId ?? undefined,
        );
      }
      touchThread(thread.id);
      return isCurrentDraft;
    } catch {
      if (
        draftPersistingRef.current === persistAttempt &&
        activeConversationIdRef.current === conversationId
      ) {
        setDraftSendError("Could not create the task. Try again.");
      }
      return false;
    } finally {
      if (draftPersistingRef.current === persistAttempt) {
        draftPersistingRef.current = null;
      }
    }
  }, [
    addOptimisticSentMessage,
    conversationId,
    createThread,
    isHermesDm,
    otherParticipant?.bot?.id,
    touchThread,
    wsSendMessage,
  ]);

  const handleStopHermesTask = useCallback(() => {
    if (!isHermesDm) return;
    sendHermesMessageNow("/stop", activeThreadId);
  }, [activeThreadId, isHermesDm, sendHermesMessageNow]);

  const handleBranchCommand = useCallback(async (args: string) => {
    if (!isHermesDm) return false;
    if (draftTaskActive && draftPersistingRef.current) return false;
    const branchPersistAttempt = draftTaskActive
      ? Symbol("persist-hermes-branch-draft")
      : null;
    if (branchPersistAttempt) {
      draftPersistingRef.current = branchPersistAttempt;
      setDraftSendError(null);
    }
    const sourceThread = !draftTaskActive && activeThreadId
      ? threadsRef.current.find((thread) => thread.id === activeThreadId)
      : null;
    const branchTitle = titleFromBranchCommand(args, sourceThread?.title);

    try {
      const thread = await createThread({
        botId: otherParticipant?.bot?.id,
        title: branchTitle,
        branchFromThreadId: sourceThread?.id ?? null,
      });
      const isCurrentConversation =
        activeConversationIdRef.current === conversationId &&
        (!branchPersistAttempt || draftPersistingRef.current === branchPersistAttempt);
      if (thread && isCurrentConversation) {
        setDraftTaskActive(false);
        setActiveThreadId(thread.id);
      }
      return !!thread && isCurrentConversation;
    } catch {
      if (
        activeConversationIdRef.current === conversationId &&
        (!branchPersistAttempt || draftPersistingRef.current === branchPersistAttempt)
      ) {
        setDraftSendError("Could not create the task. Try again.");
      }
      return false;
    } finally {
      if (branchPersistAttempt && draftPersistingRef.current === branchPersistAttempt) {
        draftPersistingRef.current = null;
      }
    }
  }, [
    activeThreadId,
    createThread,
    draftTaskActive,
    isHermesDm,
    otherParticipant?.bot?.id,
  ]);

  const handleSend = useCallback((
    content: string,
    attachmentIds: string[] = [],
  ) => {
    if (!isHermesDm) {
      return channelSendMessage(content, attachmentIds);
    }
    if (draftTaskActive && !content.trim()) return false;

    const slash = parseHermesSlashCommand(content);
    const canonical = slash
      ? canonicalHermesSlashCommand(slash.command, slashCommands) ?? slash.command
      : null;
    if (canonical === "/branch" && attachmentIds.length === 0) {
      return handleBranchCommand(slash!.args);
    }
    if (draftTaskActive) {
      return persistDraftAndSend(content, attachmentIds);
    }
    if (slash) {
      // Manual typed approval commands remain regular visible chat messages.
      // Record their optimistic state only after the send pipeline accepts
      // the message; inline buttons use the direct interaction route instead.
      const approvalDecision = decisionFromApprovalCommand(content);
      if (approvalDecision) {
        const pending = pendingApprovalEvents(
          activeHermesProgressRef.current.invocations,
          useHermesApprovalsStore.getState().decisions,
        );
        const targets = approvalDecision.all ? pending : pending.slice(0, 1);
        return sendHermesMessageNow(content, activeThreadId, attachmentIds).then(
          (accepted) => {
            if (accepted !== false) {
              for (const event of targets) {
                recordApprovalDecision(event.id, approvalDecision.decision);
              }
            }
            return accepted;
          },
        );
      }
      return sendHermesMessageNow(content, activeThreadId, attachmentIds);
    }
    // TheChat intentionally does not queue normal Hermes DM messages locally.
    // Hermes owns the busy-turn policy: default messages can interrupt/steer
    // according to gateway config, while /queue passes through to Hermes' FIFO.
    return sendHermesMessageNow(content, activeThreadId, attachmentIds);
  }, [
    activeThreadId,
    channelSendMessage,
    draftTaskActive,
    handleBranchCommand,
    isHermesDm,
    persistDraftAndSend,
    sendHermesMessageNow,
    slashCommands,
  ]);

  const handleHermesInteraction = useCallback(
    async (
      event: BotInvocationProgressEventPublic,
      response: string | string[],
    ) => {
      if (!isHermesDm || !token) {
        throw new Error("Sign in to respond to Hermes");
      }
      await submitHermesInteraction(
        event.invocationId,
        event.id,
        response,
        token,
      );
      invalidate(conversationId);
    },
    [conversationId, invalidate, isHermesDm, token],
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {isHermesDm ? (
          <HermesDmChatView
            messages={draftTaskActive ? [] : channelChat.messages}
            loading={
              draftTaskActive
                ? false
                : channelChat.loading ||
                  conversationLoading ||
                  conversationPending
            }
            loadingOlder={channelChat.loadingOlder}
            hasOlderMessages={channelChat.hasOlderMessages}
            sendError={draftSendError ?? channelChat.sendError}
            typingUsers={typingUsers}
            progressInvocations={activeHermesProgress.invocations}
            typingSuppressedUserIds={activeHermesProgress.typingSuppressedUserIds}
            onSend={handleSend}
            onInteraction={handleHermesInteraction}
            onStop={handleStopHermesTask}
            onLoadOlderMessages={channelChat.loadOlderMessages}
            onSetReaction={channelChat.setReaction}
            mentions={mentions}
            scrollKey={`${conversationId}:${
              draftTaskActive ? "draft" : activeThreadId ?? "general"
            }`}
            draftKey={composerDraftKey.dm(
              user?.id,
              conversationId,
              draftTaskActive
                ? `${LOCAL_TASK_DRAFT_SCOPE}:${draftComposerRevision}`
                : activeThreadId,
            )}
            taskActive={taskActive}
            slashCommands={slashCommands}
            conversationId={conversationId}
            token={token}
            composerKey={draftComposerRevision}
          />
        ) : (
          <ChannelChatView
            messages={channelChat.messages}
            loading={
              channelChat.loading ||
              conversationLoading ||
              conversationPending
            }
            loadingOlder={channelChat.loadingOlder}
            hasOlderMessages={channelChat.hasOlderMessages}
            sendError={channelChat.sendError}
            typingUsers={typingUsers}
            onSend={handleSend}
            onLoadOlderMessages={channelChat.loadOlderMessages}
            onSetReaction={channelChat.setReaction}
            mentions={mentions}
            scrollKey={conversationId}
            draftKey={composerDraftKey.dm(user?.id, conversationId)}
            conversationId={conversationId}
            token={token}
          />
        )}
      </div>
      {isHermesDm && (
        <HermesRuntimePanel
          botName={otherParticipant.user.name}
          runtime={runtime}
          loading={runtimeLoading}
          threads={threads}
          threadsLoading={threadsLoading}
          threadsLoadingMore={threadsLoadingMore}
          threadsHasMore={threadsHasMore}
          activeThreadId={activeThreadId}
          draftTaskActive={draftTaskActive}
          onSelectThread={handleSelectThread}
          onCreateThread={handleCreateThread}
          approvalThreadIds={approvalThreadIds}
          generalNeedsApproval={generalNeedsApproval}
          unreadThreadIds={unreadThreadIds}
          generalUnread={generalUnread}
          onLoadMoreThreads={() => {
            void loadMoreThreads();
          }}
        />
      )}
    </div>
  );
}

function titleFromMessage(content: string) {
  const normalized = content.trim().replace(/\s+/g, " ");
  if (!normalized) return "New task";
  return normalized.length > 48 ? `${normalized.slice(0, 45)}...` : normalized;
}

function titleFromBranchCommand(args: string, sourceTitle?: string | null) {
  const explicitTitle = args.trim().replace(/\s+/g, " ");
  if (explicitTitle) return titleFromMessage(explicitTitle);
  const normalizedSourceTitle = sourceTitle?.trim();
  if (normalizedSourceTitle && normalizedSourceTitle !== "New task") {
    return titleFromMessage(`${normalizedSourceTitle} branch`);
  }
  return "Branch";
}

function isAutoNamedThread(thread: { title: string } | null | undefined) {
  return thread?.title.trim() === "New task";
}
