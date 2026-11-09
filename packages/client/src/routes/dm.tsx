import { isAuthenticated } from "../lib/auth-identity";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useSearch } from "@tanstack/react-router";
import { useAuthStore } from "../stores/auth";
import { useActivityStore } from "../stores/activity";
import { useDmHeaderIdentity } from "../stores/chat-header";
import {
  useBotRuntime,
  useBotRuntimeCache,
  submitHermesVaultUnlock,
  submitHermesSecureInput,
} from "../hooks/useBotRuntime";
import type { BotAppearance } from "@thechat/shared";
import { useConversationThreads } from "../hooks/useConversationThreads";
import { useTaskProjects } from "../hooks/useTaskProjects";
import { useConversationDetail } from "../hooks/useConversationDetail";
import { useScopedCommands } from "../hooks/useScopedCommands";
import { useWebSocketStore } from "../stores/websocket";
import { useWorkspacesStore } from "../stores/workspaces";
import {
  composerDraftKey,
  useComposerDraftsStore,
} from "../stores/composer-drafts";
import { useChannelChat } from "../hooks/useChannelChat";
import { usePersistConversationRead } from "../hooks/usePersistConversationRead";
import { ChannelChatView } from "../components/ChannelChatView";
import { HermesDmChatView } from "../components/HermesDmChatView";
import { HermesRuntimePanel } from "../components/HermesRuntimePanel";
import { BranchEmptyState, TaskBranchBar } from "../components/TaskBranchBar";
import { HeaderAction } from "../components/HeaderActions";
import { iconButtonClass } from "../components/ui";
import { GitBranchPlus } from "lucide-react";
import { childBranches, isBranch, nextBranchTitle } from "../lib/task-tree";
import { requestInputBarFocus } from "../stores/input-focus";
import { closePaletteAndRefocus } from "../CommandPalette";
import { useLocationJumpStore, usePendingMessageJump } from "../lib/search-navigation";
import { useRecentLocationsStore } from "../stores/recent-locations";
import type { Command } from "../commands";
import { wsEvents, type WsEvents } from "../lib/ws-events";
import { botAppearanceFor } from "../lib/bot-appearance";
import { selectHermesConversationProgress } from "../lib/hermes-progress";
import { useConversationBotRequests } from "../stores/bot-requests";
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
  const { threadId: requestedThreadId } = useSearch({ from: "/dm/$id" });
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const members = useWorkspacesStore((s) => s.activeWorkspace?.members);
  const wsSendMessage = useWebSocketStore((s) => s.sendMessage);
  const conversationQuery = useConversationDetail(conversationId, token);
  const conversation = conversationQuery.data ?? null;
  const conversationLoading = conversationQuery.isLoading;
  const conversationPending = !conversation && isAuthenticated(token) && !conversationQuery.error;

  const mentions = useMemo(
    () =>
      members
        ?.filter((m) => m.userId !== user?.id)
        .map((m) => ({
          id: m.userId,
          label: m.user.name,
          type: m.user.type,
          botAvatar:
            m.user.type === "bot"
              ? botAppearanceFor(m.userId, m.bot?.avatar)
              : undefined,
        })),
    [members, user?.id]
  );

  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const otherParticipant = useMemo(
    () => conversation?.participants.find((p) => p.userId !== user?.id) ?? null,
    [conversation, user?.id],
  );
  const progressBotAppearances = useMemo(
    () => new Map<string, BotAppearance>(
      conversation?.participants.flatMap((participant) =>
        participant.bot?.avatar ? [[participant.userId, participant.bot.avatar] as const] : [],
      ),
    ),
    [conversation],
  );
  const isHermesDm = conversation?.type === "direct" && otherParticipant?.bot?.kind === "hermes";
  const registeredBotCommands = otherParticipant?.bot?.commands;
  const slashCommands = useMemo(
    () => buildHermesSlashCommands(registeredBotCommands),
    [registeredBotCommands],
  );
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    requestedThreadId ?? null,
  );
  const [draftTaskActive, setDraftTaskActive] = useState(false);
  const [draftSendError, setDraftSendError] = useState<string | null>(null);
  const [draftComposerRevision, setDraftComposerRevision] = useState(0);
  const localTaskDraftKey = composerDraftKey.dm(
    user?.id,
    conversationId,
    LOCAL_TASK_DRAFT_SCOPE,
  );
  const storedDraftTaskPresent = useComposerDraftsStore(
    (state) =>
      Boolean(state.drafts[localTaskDraftKey]) ||
      Boolean(state.imageDrafts[localTaskDraftKey]?.length) ||
      Boolean(state.attachmentDrafts[localTaskDraftKey]?.length),
  );
  const draftTaskPresent = draftTaskActive || storedDraftTaskPresent;
  const activeConversationIdRef = useRef(conversationId);
  activeConversationIdRef.current = conversationId;
  const draftPersistingRef = useRef<symbol | null>(null);
  const runtimeQuery = useBotRuntime(conversationId, token, isHermesDm);
  const runtime = runtimeQuery.data ?? null;
  const runtimeLoading = runtimeQuery.isLoading;
  const threadState = useConversationThreads(conversationId, token, isHermesDm, {
    activeThreadId,
  });
  const {
    threads,
    groups: threadGroups,
    loadMore: loadMoreThreads,
    createThread,
    renameThread,
    moveThread,
    deleteThread,
    touchThread,
    activeThreadMissing,
  } = threadState;
  const threadsLoading = threadState.loading;
  const {
    projects,
    createProject,
    renameProject,
    deleteProject,
  } = useTaskProjects(conversationId, token, isHermesDm);
  // The project a new draft task will be filed under when it is first sent.
  const [draftTaskProjectId, setDraftTaskProjectId] = useState<string | null>(null);
  const { mergeInvocationUpdate, mergeProgressEvent, invalidate } =
    useBotRuntimeCache();
  const generalThreadActive = isHermesDm && !draftTaskActive && activeThreadId === null;
  useDmHeaderIdentity({
    conversationId,
    userId: user?.id ?? null,
    token,
    title: otherParticipant?.user.name ?? "",
    context: isHermesDm
      ? draftTaskActive ? "New task"
        : activeThreadId ? threads.find((thread) => thread.id === activeThreadId)?.title
          : "General"
      : undefined,
  });
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

  // Attention indicators: which tasks in this DM wait on a request or
  // finished unread. Requests come from PostgreSQL rows, not progress events.
  const conversationRequests = useConversationBotRequests(conversationId);
  const pendingInteractions = useMemo(
    () =>
      conversationRequests.filter(
        (request) =>
          request.status === "open" &&
          (!request.audienceUserId || request.audienceUserId === user?.id),
      ),
    [conversationRequests, user?.id],
  );
  const unreadScopes = useHermesIndicatorsStore((s) => s.unreadScopes);
  const unreadActivity = useActivityStore((s) =>
    s.items.find((item) => item.conversationId === conversationId),
  );
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
    const ids = new Set<string | null>(
      unreadActivity
        ? unreadActivity.unreadThreadIds ?? [unreadActivity.latestMessage.threadId]
        : [],
    );
    for (const scope of Object.values(unreadScopes)) {
      if (scope.conversationId !== conversationId) continue;
      ids.add(scope.threadId);
    }
    return ids;
  }, [conversationId, unreadActivity, unreadScopes]);
  const generalUnread = unreadThreadIds.has(null);
  const taskUnreadThreadIds = useMemo(
    () => new Set([...unreadThreadIds].filter((id): id is string => id !== null)),
    [unreadThreadIds],
  );

  // Runs that started before this client connected still count for unread.
  useEffect(() => {
    if (!isHermesDm || !runtime) return;
    useHermesIndicatorsStore.getState().seedFromSnapshot(runtime);
  }, [isHermesDm, runtime]);

  // Keep the indicators store in sync with what the user is looking at.
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

  const channelChat = useChannelChat({
    conversationId: chatConversationId,
    threadId: isHermesDm ? activeThreadId : null,
    unthreadedOnly: generalThreadActive,
    taskRead: isHermesDm,
    enabled: !draftTaskActive,
    token,
    wsSendMessage,
    selfUser: user,
  });
  usePersistConversationRead(
    chatConversationId,
    channelChat.messages,
    !draftTaskActive && !channelChat.loading,
    isHermesDm ? { threadId: activeThreadId, snapshot: channelChat.taskReadSnapshot } : undefined,
  );

  // "Open conversation" from a message: open this chat at that message. A
  // Hermes DM shows one task at a time, so only that task's messages qualify.
  const { jump, onJumpDone } = usePendingMessageJump(
    conversationId,
    isHermesDm ? (draftTaskActive ? LOCAL_TASK_DRAFT_SCOPE : activeThreadId) : undefined,
  );

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

  // Keep Activity deep links and browser navigation aligned with task state.
  // A quick-switcher jump re-applies the URL's task even when the URL did not
  // change (jumping to "Koda" from one of Koda's tasks lands on General).
  const jumpNonce = useLocationJumpStore((state) =>
    state.conversationId === conversationId ? state.nonce : 0,
  );
  useEffect(() => {
    setActiveThreadId(requestedThreadId ?? null);
    setDraftTaskActive(false);
    setDraftSendError(null);
    draftPersistingRef.current = null;
  }, [conversationId, requestedThreadId, jumpNonce]);

  // Recent places for the quick switcher, from every way of getting here.
  useEffect(() => {
    if (draftTaskActive) return;
    useRecentLocationsStore.getState().enter({
      conversationId,
      type: "direct",
      threadId: isHermesDm ? activeThreadId : null,
    });
  }, [activeThreadId, conversationId, draftTaskActive, isHermesDm]);
  useEffect(() => () => useRecentLocationsStore.getState().leave(conversationId), [conversationId]);

  // A task that is on no loaded page is fetched on its own; only a task the
  // server no longer has (deleted, or a stale link) falls back to General.
  useEffect(() => {
    if (isHermesDm && activeThreadMissing) setActiveThreadId(null);
  }, [activeThreadMissing, isHermesDm]);

  const handleCreateThread = useCallback((projectId: string | null = null) => {
    if (!isHermesDm || draftPersistingRef.current) return;
    setDraftSendError(null);
    setActiveThreadId(null);
    setDraftTaskActive(true);
    setDraftTaskProjectId(projectId);
    setDraftComposerRevision((revision) => revision + 1);
  }, [isHermesDm]);

  const handleDeleteThread = useCallback(async (threadId: string) => {
    await deleteThread(threadId);
    if (activeThreadId === threadId) setActiveThreadId(null);
  }, [activeThreadId, deleteThread]);

  // Deleting the project a draft was aimed at files the draft nowhere.
  useEffect(() => {
    if (draftTaskProjectId && !projects.some((project) => project.id === draftTaskProjectId)) {
      setDraftTaskProjectId(null);
    }
  }, [draftTaskProjectId, projects]);

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
        ...(draftTaskProjectId ? { projectId: draftTaskProjectId } : {}),
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
    draftTaskProjectId,
    isHermesDm,
    otherParticipant?.bot?.id,
    touchThread,
    wsSendMessage,
  ]);

  const handleStopHermesTask = useCallback(() => {
    if (!isHermesDm) return;
    sendHermesMessageNow("/stop", activeThreadId);
  }, [activeThreadId, isHermesDm, sendHermesMessageNow]);

  /**
   * Creates a branch of a task, or with null of the General lane, and opens
   * it. Hermes copies the source's conversation into the branch when its
   * first message arrives. Every branch entry point (the /branch command, the
   * header button, a task's menu, C-x b) goes through here.
   */
  const createBranch = useCallback(async (
    sourceThreadId: string | null,
    explicitTitle?: string,
  ) => {
    if (!isHermesDm || draftPersistingRef.current) return false;
    const attempt = Symbol("create-hermes-branch");
    draftPersistingRef.current = attempt;
    setDraftSendError(null);
    const loaded = threadsRef.current;
    const source = sourceThreadId
      ? loaded.find((thread) => thread.id === sourceThreadId) ?? null
      : null;
    const title = explicitTitle?.trim()
      ? titleFromMessage(explicitTitle)
      : nextBranchTitle(
          source?.title ?? null,
          childBranches(sourceThreadId, loaded).map((thread) => thread.title),
        );
    const isCurrent = () =>
      activeConversationIdRef.current === conversationId &&
      draftPersistingRef.current === attempt;

    try {
      const thread = await createThread({
        botId: otherParticipant?.bot?.id,
        title,
        branchFromThreadId: sourceThreadId,
      });
      const current = isCurrent();
      if (thread && current) {
        setDraftTaskActive(false);
        setActiveThreadId(thread.id);
        requestInputBarFocus();
      }
      if (!thread && current) setDraftSendError("Could not create the branch. Try again.");
      return !!thread && current;
    } catch {
      if (isCurrent()) setDraftSendError("Could not create the branch. Try again.");
      return false;
    } finally {
      if (draftPersistingRef.current === attempt) draftPersistingRef.current = null;
    }
  }, [
    conversationId,
    createThread,
    isHermesDm,
    otherParticipant?.bot?.id,
  ]);

  // `/branch [name]` branches whatever is open; a New task draft has no
  // conversation yet, so it branches from General as before.
  const handleBranchCommand = useCallback(
    (args: string) =>
      createBranch(!draftTaskActive && activeThreadId ? activeThreadId : null, args),
    [activeThreadId, createBranch, draftTaskActive],
  );

  const activeThread = useMemo(
    () =>
      !draftTaskActive && activeThreadId
        ? threads.find((thread) => thread.id === activeThreadId) ?? null
        : null,
    [activeThreadId, draftTaskActive, threads],
  );
  const canBranchActive = isHermesDm && !draftTaskActive;
  const branchActive = useCallback(() => {
    if (!canBranchActive) return;
    void createBranch(activeThreadId);
  }, [activeThreadId, canBranchActive, createBranch]);
  const branchSourceId = activeThread?.branchFromThreadId ?? null;
  const branchCommands = useMemo<Command[]>(
    () => [
      {
        id: "hermes.branch-task",
        label: activeThreadId ? "Branch Task" : "Branch General",
        shortcut: "C-x b",
        keybinding: { prefix: "C-x", key: "b" },
        enabled: canBranchActive,
        priority: 100,
        execute: () => {
          closePaletteAndRefocus();
          branchActive();
        },
      },
      {
        id: "hermes.go-to-branch-source",
        label: "Go to Branch Source",
        shortcut: null,
        keybinding: null,
        enabled: isHermesDm && !!activeThread && isBranch(activeThread),
        priority: 100,
        execute: () => {
          closePaletteAndRefocus();
          handleSelectThread(branchSourceId);
        },
      },
    ],
    [
      activeThread,
      activeThreadId,
      branchActive,
      branchSourceId,
      canBranchActive,
      handleSelectThread,
      isHermesDm,
    ],
  );
  useScopedCommands(branchCommands);

  const handleSend = useCallback((
    content: string,
    attachmentIds: string[] = [],
  ) => {
    if (!isHermesDm) {
      return channelSendMessage(content, attachmentIds);
    }
    if (draftTaskActive && !content.trim() && attachmentIds.length === 0) return false;

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
      // Typed /approve and /deny stay regular chat messages. Hermes resolves
      // its waiter and withdraws the matching request, which closes the card.
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

  const activeBranchSource = activeThread?.branchFromThreadId
    ? threads.find((thread) => thread.id === activeThread.branchFromThreadId) ?? null
    : null;

  return (
    <div className="shared-dm-layout flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {isHermesDm && canBranchActive && (
          <HeaderAction>
            <button
              type="button"
              className={iconButtonClass("md")}
              onClick={branchActive}
              aria-label={activeThread ? `Branch “${activeThread.title}”` : "Branch General"}
              title={`Branch ${activeThread ? "this task" : "General"} (C-x b)`}
              data-testid="branch-active-task"
            >
              <GitBranchPlus size={16} aria-hidden="true" />
            </button>
          </HeaderAction>
        )}
        {isHermesDm && !draftTaskActive && (
          <TaskBranchBar
            activeThread={activeThread}
            threads={threads}
            unreadThreadIds={taskUnreadThreadIds}
            approvalThreadIds={approvalThreadIds}
            onSelectThread={handleSelectThread}
          />
        )}
        {isHermesDm ? (
          <HermesDmChatView
            emptyState={
              activeThread && isBranch(activeThread) ? (
                <BranchEmptyState
                  sourceTitle={
                    activeThread.branchFromThreadId
                      ? activeBranchSource?.title ?? "the source task"
                      : null
                  }
                />
              ) : undefined
            }
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
            botAppearances={progressBotAppearances}
            typingSuppressedUserIds={activeHermesProgress.typingSuppressedUserIds}
            onSend={handleSend}
            requestScope={{
              conversationId,
              threadId: draftTaskActive ? LOCAL_TASK_DRAFT_SCOPE : activeThreadId,
            }}
            onVaultUnlock={async (event,response)=> {
              if (!isHermesDm || !isAuthenticated(token)) throw new Error("Vault unlock unavailable");
              await submitHermesVaultUnlock(event.invocationId,event.id,response,token);
              invalidate(conversationId);
            }}
            onSecureInput={async (event, response) => {
              if (!isHermesDm || !isAuthenticated(token)) throw new Error("Secure input unavailable");
              await submitHermesSecureInput(event.invocationId, event.id, response, token);
              invalidate(conversationId);
            }}
            onStop={handleStopHermesTask}
            onLoadOlderMessages={channelChat.loadOlderMessages}
            onSetReaction={channelChat.setReaction}
            mentions={mentions}
            scrollKey={`${conversationId}:${
              draftTaskActive ? "draft" : activeThreadId ?? "general"
            }`}
            draftKey={
              draftTaskActive
                ? localTaskDraftKey
                : composerDraftKey.dm(user?.id, conversationId, activeThreadId)
            }
            taskActive={taskActive}
            slashCommands={slashCommands}
            conversationId={conversationId}
            token={token}
            composerKey={draftComposerRevision}
            jump={jump}
            onJumpDone={onJumpDone}
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
            jump={jump}
            onJumpDone={onJumpDone}
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
          threadGroups={threadGroups}
          activeThreadId={activeThreadId}
          draftTaskActive={draftTaskActive}
          draftTaskPresent={draftTaskPresent}
          onSelectThread={handleSelectThread}
          onRenameThread={renameThread}
          onCreateThread={handleCreateThread}
          projects={projects}
          draftTaskProjectId={draftTaskProjectId}
          onCreateProject={createProject}
          onRenameProject={renameProject}
          onDeleteProject={deleteProject}
          onMoveThread={moveThread}
          onDeleteThread={handleDeleteThread}
          onBranchThread={(threadId) => void createBranch(threadId)}
          approvalThreadIds={approvalThreadIds}
          generalNeedsApproval={generalNeedsApproval}
          unreadThreadIds={taskUnreadThreadIds}
          generalUnread={generalUnread}
          onLoadMoreThreads={(projectId) => {
            void loadMoreThreads(projectId);
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

function isAutoNamedThread(thread: { title: string } | null | undefined) {
  return thread?.title.trim() === "New task";
}
