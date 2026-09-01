import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AcpCapabilities,
  AcpPermissionMode,
  AcpPromptContent,
  Conversation,
  DbMessage,
  Message,
  MessagePart,
} from "@thechat/shared";
import {
  createAcpEventState,
  reduceAcpEvent,
  type AcpEventState,
} from "../acp/event-reducer";
import {
  beginAcpTurn,
  cancelAcp,
  completeAcpTurn,
  connectAcp,
  disconnectAcp,
  promptAcp,
  respondToAcpPermission,
} from "../lib/acp-client";
import { saveImage, type ImageAttachment } from "../lib/images";
import { useAcpStore } from "../stores/acp";
import {
  recordToolCallStart,
  updateStreamParts,
  useStreamingStore,
} from "../stores/streaming";

const MESSAGE_PAGE_SIZE = 20;
const MESSAGE_WINDOW_SIZE = 120;
const MESSAGE_WINDOW_TRIM_THRESHOLD = 160;
const MAX_ACP_PROMPT_BLOCKS = 64;
const MAX_ACP_PROMPT_TEXT_BYTES = 256 * 1024;
const MAX_ACP_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ACP_PROMPT_TOTAL_BYTES = 16 * 1024 * 1024;

interface SessionRecord {
  conversationId: string;
  profileId: string;
  cwd: string;
  generation: number;
  connected: boolean;
  sessionId: string | null;
  profileFingerprint: string | null;
  capabilities: AcpCapabilities | null;
  lastUsed: number;
}

interface ActivePrompt {
  generation: number;
  cancelled: boolean;
}

const sessions = new Map<string, SessionRecord>();
const activePrompts = new Map<string, ActivePrompt>();
const generationCounters = new Map<string, number>();
const turnStates = new Map<string, AcpEventState>();
const visibleConversationOwners = new Map<string, number>();
const GENERATION_STORAGE_PREFIX = "thechat:acp:generation:";

function isConversationVisible(conversationId: string) {
  return (visibleConversationOwners.get(conversationId) ?? 0) > 0;
}

function retainConversationVisibility(conversationId: string) {
  visibleConversationOwners.set(
    conversationId,
    (visibleConversationOwners.get(conversationId) ?? 0) + 1,
  );
}

function releaseConversationVisibility(conversationId: string) {
  const remaining = (visibleConversationOwners.get(conversationId) ?? 1) - 1;
  if (remaining > 0) visibleConversationOwners.set(conversationId, remaining);
  else visibleConversationOwners.delete(conversationId);
}

async function retireSession(conversationId: string, clearRuntime: boolean) {
  const session = sessions.get(conversationId);
  if (!session || activePrompts.has(conversationId)) return;
  sessions.delete(conversationId);
  try {
    if (session.connected) {
      await disconnectAcp({
        conversationId,
        generation: session.generation,
      });
    }
  } catch {
    // The backend generation guard prevents a stale cleanup from touching a replacement.
  } finally {
    if (!sessions.has(conversationId)) {
      turnStates.delete(conversationId);
      if (clearRuntime) useAcpStore.getState().clearRuntime(conversationId);
    }
  }
}

const MAX_FRONTEND_ACP_SESSIONS = 8;

async function ensureSessionCapacity(exceptConversationId: string) {
  if (sessions.size < MAX_FRONTEND_ACP_SESSIONS) return;
  const idle = [...sessions.values()]
    .filter(
      (session) =>
        session.conversationId !== exceptConversationId &&
        !activePrompts.has(session.conversationId) &&
        !isConversationVisible(session.conversationId),
    )
    .sort((left, right) => left.lastUsed - right.lastUsed);
  for (const session of idle) {
    await retireSession(session.conversationId, true);
    if (sessions.size < MAX_FRONTEND_ACP_SESSIONS) return;
  }
  if (sessions.size >= MAX_FRONTEND_ACP_SESSIONS) {
    throw new Error("Too many active ACP sessions; close or stop another Agent Chat first.");
  }
}

export interface AcpChatError {
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface UseAcpChatOptions {
  profileId: string | null;
  projectDir: string | null;
  permissionMode: AcpPermissionMode;
  /** False when the selected persisted profile was deleted or disabled. */
  profileAvailable?: boolean;
  onStreamComplete?: (
    conversationId: string,
    title: string,
    visible: boolean,
  ) => void;
}

export function useAcpChat(options: UseAcpChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState<AcpChatError | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const creatingConversationRef = useRef(false);
  const activeConversationIdRef = useRef<string | null>(null);
  const visibilityOwnerRef = useRef<string | null>(null);
  const conversationRef = useRef<Conversation | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  conversationRef.current = conversation;
  messagesRef.current = messages;
  activeConversationIdRef.current = conversation?.id ?? null;

  const ownConversationVisibility = useCallback((nextConversationId: string | null) => {
    const previousConversationId = visibilityOwnerRef.current;
    if (previousConversationId === nextConversationId) return;
    if (previousConversationId) {
      releaseConversationVisibility(previousConversationId);
      queueMicrotask(() => {
        if (!isConversationVisible(previousConversationId)) {
          void retireSession(previousConversationId, true);
        }
      });
    }
    visibilityOwnerRef.current = nextConversationId;
    if (nextConversationId) retainConversationVisibility(nextConversationId);
  }, []);

  useEffect(
    () => () => {
      ownConversationVisibility(null);
    },
    [ownConversationVisibility],
  );

  const runtime = useAcpStore((state) =>
    conversation?.id ? state.runtimes[conversation.id] : undefined,
  );
  const turnActivity = useAcpStore((state) =>
    conversation?.id ? state.turnActivities[conversation.id] : undefined,
  );

  const appendVisibleMessage = useCallback((message: Message) => {
    setMessages((previous) => {
      if (previous.some((candidate) => candidate.id === message.id)) return previous;
      const next = [...previous, message];
      if (next.length <= MESSAGE_WINDOW_TRIM_THRESHOLD) return next;
      setHasOlderMessages(true);
      return next.slice(-MESSAGE_WINDOW_SIZE);
    });
  }, []);

  useEffect(() => {
    const message = turnActivity?.lastMessage;
    if (!message || message.conversation_id !== conversation?.id) return;
    appendVisibleMessage(dbMessageToMessage(message));
  }, [appendVisibleMessage, conversation?.id, turnActivity?.completionVersion]);

  const loadConversation = useCallback(async (nextConversation: Conversation) => {
    ownConversationVisibility(nextConversation.id);
    activeConversationIdRef.current = nextConversation.id;
    conversationRef.current = nextConversation;
    setConversation(nextConversation);
    setMessages([]);
    setError(null);
    setHasOlderMessages(false);
    setLoadingMessages(true);
    try {
      const dbMessages = await loadDbMessages(nextConversation.id, MESSAGE_PAGE_SIZE);
      if (activeConversationIdRef.current !== nextConversation.id) return;
      setMessages(dbMessages.map(dbMessageToMessage));
      setHasOlderMessages(dbMessages.length === MESSAGE_PAGE_SIZE);
    } catch (loadError) {
      if (activeConversationIdRef.current === nextConversation.id) {
        setError({ message: errorMessage(loadError), retryable: true });
      }
    } finally {
      if (activeConversationIdRef.current === nextConversation.id) {
        setLoadingMessages(false);
      }
    }
  }, [ownConversationVisibility]);

  const loadOlderMessages = useCallback(async () => {
    const currentConversation = conversationRef.current;
    const oldest = messagesRef.current[0];
    if (
      !currentConversation ||
      !oldest ||
      !hasOlderMessages ||
      loadingOlderMessages
    ) {
      return false;
    }
    setLoadingOlderMessages(true);
    try {
      const dbMessages = await loadDbMessages(
        currentConversation.id,
        MESSAGE_PAGE_SIZE,
        oldest.created_at,
      );
      if (activeConversationIdRef.current !== currentConversation.id) return false;
      const older = dbMessages.map(dbMessageToMessage);
      setMessages((current) => prependMessages(current, older));
      setHasOlderMessages(dbMessages.length === MESSAGE_PAGE_SIZE);
      return older.length > 0;
    } finally {
      if (activeConversationIdRef.current === currentConversation.id) {
        setLoadingOlderMessages(false);
      }
    }
  }, [hasOlderMessages, loadingOlderMessages]);

  const startNewConversation = useCallback(() => {
    ownConversationVisibility(null);
    activeConversationIdRef.current = null;
    conversationRef.current = null;
    setConversation(null);
    setMessages([]);
    setError(null);
    setHasOlderMessages(false);
    setLoadingMessages(false);
    setLoadingOlderMessages(false);
  }, [ownConversationVisibility]);

  const sendMessage = useCallback(
    async (content: string, images?: ImageAttachment[]): Promise<boolean> => {
      const text = content.trim();
      if (!text && (!images || images.length === 0)) return false;

      const admissionError = validatePromptAdmission(text, images);
      if (admissionError) {
        setError({ message: admissionError, retryable: false });
        return false;
      }

      const selectedProfileId = optionsRef.current.profileId;
      const selectedProjectDir = optionsRef.current.projectDir;
      if (!selectedProfileId) {
        setError({ message: "Select an agent profile before sending." });
        return false;
      }
      if (optionsRef.current.profileAvailable === false) {
        setError({
          message:
            "The selected agent profile is unavailable. Restore it or explicitly choose a profile for a new chat.",
        });
        return false;
      }
      if (!selectedProjectDir) {
        setError({ message: "Select an existing project folder before sending." });
        return false;
      }

      let currentConversation = conversationRef.current;
      if (currentConversation?.agent_profile_id == null && currentConversation) {
        setError({
          message: "This is a legacy direct-model conversation and cannot be opened as ACP chat.",
        });
        return false;
      }
      if (
        currentConversation?.agent_profile_id &&
        currentConversation.agent_profile_id !== selectedProfileId
      ) {
        setError({
          message: `This conversation uses profile ${currentConversation.agent_profile_id}. Start a new chat to use ${selectedProfileId}; profiles are never switched silently.`,
        });
        return false;
      }
      if (
        currentConversation?.project_dir &&
        currentConversation.project_dir !== selectedProjectDir
      ) {
        setError({
          message: `This conversation is locked to ${currentConversation.project_dir}. Start a new chat to use another project.`,
        });
        return false;
      }

      if (!currentConversation && creatingConversationRef.current) {
        setError({ message: "A prompt is already active while this conversation is being created." });
        return false;
      }
      if (currentConversation && activePrompts.has(currentConversation.id)) {
        setError({ message: "A prompt is already active for this conversation." });
        return false;
      }

      setError(null);
      if (!currentConversation) {
        creatingConversationRef.current = true;
        try {
          const titleText = text || "Image conversation";
          const title =
            titleText.length > 50 ? `${titleText.slice(0, 50)}...` : titleText;
          const created = await invoke<Conversation>("create_conversation", {
            title,
            projectDir: selectedProjectDir,
            agentProfileId: selectedProfileId,
          });
          currentConversation = {
            ...created,
            project_dir: created.project_dir ?? selectedProjectDir,
            agent_profile_id: created.agent_profile_id ?? selectedProfileId,
          };
          conversationRef.current = currentConversation;
          activeConversationIdRef.current = currentConversation.id;
          ownConversationVisibility(currentConversation.id);
          setConversation(currentConversation);
        } catch (createError) {
          setError({ message: errorMessage(createError), retryable: true });
          return false;
        } finally {
          creatingConversationRef.current = false;
        }
      }

      const conversationId = currentConversation.id;
      if (activePrompts.has(conversationId)) {
        setError({ message: "A prompt is already active for this conversation." });
        return false;
      }

      const boundProfileId = currentConversation.agent_profile_id ?? selectedProfileId;
      const cwd = currentConversation.project_dir ?? selectedProjectDir;
      let session = sessions.get(conversationId);
      if (
        session &&
        (session.profileId !== boundProfileId || session.cwd !== cwd)
      ) {
        setError({
          message:
            "The active ACP session uses a different profile or project. Disconnect it explicitly before restarting.",
        });
        return false;
      }
      if (!session?.connected) {
        if (!session) await ensureSessionCapacity(conversationId);
        const generation = nextGeneration(conversationId);
        session = {
          conversationId,
          profileId: boundProfileId,
          cwd,
          generation,
          connected: false,
          sessionId: null,
          profileFingerprint: null,
          capabilities: null,
          lastUsed: Date.now(),
        };
        sessions.set(conversationId, session);
      }
      session.lastUsed = Date.now();

      const generation = session.generation;
      const activePrompt: ActivePrompt = { generation, cancelled: false };
      activePrompts.set(conversationId, activePrompt);
      useAcpStore.getState().setTurnBusy(conversationId, true);
      useStreamingStore.getState().startStreaming(conversationId);

      let eventState = createAcpEventState(
        conversationId,
        generation,
        session.capabilities,
      );
      turnStates.set(conversationId, eventState);
      publishRuntime(session, eventState);
      let turnAdmissionAttempted = false;
      let turnToken: string | null = null;
      let activityCompleted = false;

      try {
        if (!session.connected) {
          const connectResult = await connectAcp(
            {
              conversationId,
              profileId: boundProfileId,
              cwd,
              generation,
            },
            (lifecycleEvent) => {
              // Deliberately do not reduce connect-channel updates. Some stable
              // v1 agents replay loaded history here; SQLite is authoritative.
              if (
                lifecycleEvent.type !== "connected" &&
                lifecycleEvent.type !== "error" &&
                lifecycleEvent.type !== "disconnected"
              ) {
                return;
              }
              const currentSession = sessions.get(conversationId);
              if (!currentSession || currentSession.generation !== generation) return;
              if (
                lifecycleEvent.type === "error" ||
                lifecycleEvent.type === "disconnected"
              ) {
                currentSession.connected = false;
                if (activeConversationIdRef.current === conversationId) {
                  setError({
                    message:
                      lifecycleEvent.type === "error"
                        ? lifecycleEvent.error.message
                        : lifecycleEvent.reason ?? "ACP adapter disconnected",
                    code:
                      lifecycleEvent.type === "error"
                        ? lifecycleEvent.error.code
                        : "disconnected",
                    retryable: true,
                  });
                }
              }
            },
          );
          session.connected = true;
          session.sessionId = connectResult.sessionId;
          session.profileFingerprint = connectResult.profileFingerprint ?? null;
          session.capabilities = connectResult.capabilities;
          eventState = createAcpEventState(
            conversationId,
            generation,
            connectResult.capabilities,
          );
          turnStates.set(conversationId, eventState);
          publishRuntime(session, eventState);
        }

        if (activePrompt.cancelled) {
          session.connected = false;
          try {
            await disconnectAcp({ conversationId, generation });
          } catch {
            // Startup cancellation may already have removed the backend reservation.
          }
          throw new Error("ACP startup was cancelled");
        }

        if (images?.length && session.capabilities?.prompt?.image !== true) {
          throw new Error("This ACP adapter does not advertise image prompt support.");
        }

        const imageRefs = images?.length
          ? await Promise.all(
              images.map(async (image) => ({
                path: await saveImage(conversationId, image),
                mimeType: image.mimeType,
              })),
            )
          : [];
        const userParts: MessagePart[] = [];
        if (text) userParts.push({ type: "text", text });
        for (const image of imageRefs) {
          userParts.push({ type: "image", path: image.path, mimeType: image.mimeType });
        }
        const userContent =
          userParts.length === 1 && userParts[0].type === "text"
            ? text
            : JSON.stringify(userParts);
        turnAdmissionAttempted = true;
        const turnStart = await beginAcpTurn({
          conversationId,
          generation,
          content: userContent,
          reasoningContent: null,
        });
        turnToken = turnStart.turnToken;
        if (activeConversationIdRef.current === conversationId) {
          appendVisibleMessage(dbMessageToMessage(turnStart.message));
        }

        const contentBlocks: AcpPromptContent[] = [];
        if (text) contentBlocks.push({ type: "text", text });
        for (const image of images ?? []) {
          contentBlocks.push({
            type: "image",
            data: image.base64,
            mimeType: image.mimeType,
          });
        }

        const promptResult = await promptAcp(
          {
            conversationId,
            turnToken,
            contentBlocks,
            permissionMode: optionsRef.current.permissionMode,
            generation,
          },
          (event) => {
            const previous = eventState;
            eventState = reduceAcpEvent(eventState, event);
            turnStates.set(conversationId, eventState);
            useAcpStore.getState().updateEventState(conversationId, eventState);

            if (eventState.parts !== previous.parts) {
              for (const part of eventState.parts) {
                if (part.type === "tool-call") {
                  recordToolCallStart(conversationId, part.toolCallId);
                }
              }
              updateStreamParts(conversationId, eventState.parts);
            }
            if (
              event.type === "disconnected" ||
              (event.type === "error" && event.error.fatal)
            ) {
              const currentSession = sessions.get(conversationId);
              if (currentSession?.generation === generation) {
                currentSession.connected = false;
              }
            }
            if (eventState.error && activeConversationIdRef.current === conversationId) {
              setError({
                message: eventState.error.message,
                code: eventState.error.code,
                retryable: eventState.error.retryable ?? true,
              });
            }
          },
        );

        const fields = messagePartsToDbFields(eventState.parts);
        const assistantDbMessage = await completeAcpTurn({
          conversationId,
          generation,
          turnToken,
          content: fields.content,
          reasoningContent: fields.reasoningContent,
        });
        turnAdmissionAttempted = false;
        turnToken = null;
        activityCompleted = true;
        useAcpStore.getState().completeTurn(conversationId, assistantDbMessage);
        if (activeConversationIdRef.current === conversationId) {
          appendVisibleMessage(dbMessageToMessage(assistantDbMessage));
        }

        optionsRef.current.onStreamComplete?.(
          conversationId,
          currentConversation.title,
          isConversationVisible(conversationId),
        );
        if (
          eventState.status === "error" ||
          eventState.status === "disconnected" ||
          promptResult.stopReason === "refusal"
        ) {
          return false;
        }
        return true;
      } catch (sendError) {
        if (turnAdmissionAttempted) {
          session.connected = false;
          try {
            await disconnectAcp({ conversationId, generation });
          } catch {
            // The backend also owns the dirty ledger; a failed cleanup stays fail-closed.
          }
        }
        if (!activePrompt.cancelled && activeConversationIdRef.current === conversationId) {
          setError({ message: errorMessage(sendError), retryable: true });
        }
        optionsRef.current.onStreamComplete?.(
          conversationId,
          currentConversation.title,
          isConversationVisible(conversationId),
        );
        return false;
      } finally {
        if (!activityCompleted) {
          useAcpStore.getState().completeTurn(conversationId, null);
        }
        if (activePrompts.get(conversationId) === activePrompt) {
          activePrompts.delete(conversationId);
        }
        useStreamingStore.getState().stopStreaming(conversationId);
        if (!isConversationVisible(conversationId)) {
          await retireSession(conversationId, true);
        }
      }
    },
    [appendVisibleMessage, ownConversationVisibility],
  );

  const stopStreaming = useCallback(async () => {
    const conversationId = activeConversationIdRef.current;
    if (!conversationId) return;
    const activePrompt = activePrompts.get(conversationId);
    if (!activePrompt) return;
    activePrompt.cancelled = true;
    const currentState = turnStates.get(conversationId);
    if (currentState) {
      const cancellingState: AcpEventState = {
        ...currentState,
        status: "cancelling",
        pendingPermissions: [],
      };
      turnStates.set(conversationId, cancellingState);
      useAcpStore
        .getState()
        .updateEventState(conversationId, cancellingState);
    }
    try {
      await cancelAcp({
        conversationId,
        generation: activePrompt.generation,
      });
      useStreamingStore.getState().stopStreaming(conversationId);
    } catch (cancelError) {
      setError({ message: errorMessage(cancelError), retryable: true });
    }
  }, []);

  const respondToPermission = useCallback(
    async (optionId: string | null) => {
      const conversationId = activeConversationIdRef.current;
      if (!conversationId) return false;
      const session = sessions.get(conversationId);
      if (!session) return false;
      const permission =
        turnStates.get(conversationId)?.pendingPermissions[0];
      if (!permission) return false;
      try {
        await respondToAcpPermission({
          conversationId,
          generation: session.generation,
          requestId: permission.id,
          optionId,
        });
        useAcpStore
          .getState()
          .dismissPermission(conversationId, permission.id);
        return true;
      } catch (permissionError) {
        setError({ message: errorMessage(permissionError), retryable: true });
        return false;
      }
    },
    [],
  );

  return {
    messages,
    conversation,
    error,
    loadingMessages,
    loadingOlderMessages,
    hasOlderMessages,
    queuedMessages: [] as Array<{ id: string; content: string }>,
    isBusy:
      turnActivity?.busy === true ||
      runtime?.eventState.status === "running" ||
      runtime?.eventState.status === "cancelling" ||
      (runtime?.eventState.pendingPermissions.length ?? 0) > 0,
    status: runtime?.eventState.status ?? "idle",
    capabilities: runtime?.capabilities ?? null,
    pendingPermission:
      runtime?.eventState.pendingPermissions[0] ?? null,
    sendMessage,
    stopStreaming,
    respondToPermission,
    loadConversation,
    loadOlderMessages,
    startNewConversation,
  };
}

function publishRuntime(session: SessionRecord, eventState: AcpEventState) {
  useAcpStore.getState().setRuntime({
    conversationId: session.conversationId,
    profileId: session.profileId,
    cwd: session.cwd,
    generation: session.generation,
    sessionId: session.sessionId,
    profileFingerprint: session.profileFingerprint,
    capabilities: session.capabilities,
    eventState,
  });
}

async function loadDbMessages(
  conversationId: string,
  limit: number,
  before?: string | null,
) {
  return invoke<DbMessage[]>("get_messages", {
    conversationId,
    limit,
    before: before ?? null,
  });
}

function dbMessageToMessage(dbMessage: DbMessage): Message {
  let parts: MessagePart[];
  try {
    const parsed = JSON.parse(dbMessage.content);
    parts =
      Array.isArray(parsed) && parsed.every(isMessagePart)
        ? parsed
        : [{ type: "text", text: dbMessage.content }];
  } catch {
    parts = [{ type: "text", text: dbMessage.content }];
  }
  if (dbMessage.reasoning_content) {
    parts = [
      { type: "reasoning", text: dbMessage.reasoning_content },
      ...parts,
    ];
  }
  return {
    id: dbMessage.id,
    conversation_id: dbMessage.conversation_id,
    role: dbMessage.role,
    parts,
    created_at: dbMessage.created_at,
  };
}

function messagePartsToDbFields(parts: MessagePart[]) {
  const reasoningContent =
    parts
      .filter(
        (part): part is Extract<MessagePart, { type: "reasoning" }> =>
          part.type === "reasoning",
      )
      .map((part) => part.text)
      .join("") || null;
  const visibleParts = parts.filter((part) => part.type !== "reasoning");
  const content = visibleParts.every((part) => part.type === "text")
    ? visibleParts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
    : JSON.stringify(visibleParts);
  return { content, reasoningContent };
}

function isMessagePart(value: unknown): value is MessagePart {
  return !!value && typeof value === "object" && "type" in value;
}

function prependMessages(current: Message[], older: Message[]) {
  const seen = new Set(current.map((message) => message.id));
  return [
    ...older.filter((message) => !seen.has(message.id)),
    ...current,
  ];
}

function nextGeneration(conversationId: string) {
  const inMemory = generationCounters.get(conversationId) ?? 0;
  let persisted = 0;
  try {
    const candidate = Number(
      sessionStorage.getItem(`${GENERATION_STORAGE_PREFIX}${conversationId}`),
    );
    if (Number.isSafeInteger(candidate) && candidate >= 0) persisted = candidate;
  } catch {
    // Session storage is unavailable in some embedded or test environments.
  }
  const generation = Math.max(inMemory, persisted) + 1;
  generationCounters.set(conversationId, generation);
  try {
    sessionStorage.setItem(
      `${GENERATION_STORAGE_PREFIX}${conversationId}`,
      String(generation),
    );
  } catch {
    // The in-memory counter still protects route-level reconnects.
  }
  return generation;
}

function validatePromptAdmission(
  text: string,
  images: ImageAttachment[] | undefined,
): string | null {
  const textBytes = new TextEncoder().encode(text).byteLength;
  const blockCount = (text ? 1 : 0) + (images?.length ?? 0);
  if (blockCount > MAX_ACP_PROMPT_BLOCKS) {
    return "ACP prompt has too many content blocks for its resource limit.";
  }
  if (textBytes > MAX_ACP_PROMPT_TEXT_BYTES) {
    return "ACP prompt text exceeds its resource limit.";
  }

  let totalBytes = textBytes;
  for (const image of images ?? []) {
    if (
      image.base64.length > MAX_ACP_PROMPT_IMAGE_BYTES ||
      image.mimeType.length > 256 ||
      !image.mimeType.startsWith("image/")
    ) {
      return "ACP prompt image exceeds its resource limit.";
    }
    totalBytes += image.base64.length + image.mimeType.length;
    if (totalBytes > MAX_ACP_PROMPT_TOTAL_BYTES) {
      return "ACP prompt exceeds its aggregate resource limit.";
    }
  }
  return null;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Unknown ACP error";
}

/** Clears module-level coordination state used to survive route transitions. */
export function activeAcpSessionCountForTests() {
  return sessions.size;
}

export function resetAcpChatForTests() {
  for (const conversationId of activePrompts.keys()) {
    useStreamingStore.getState().stopStreaming(conversationId);
  }
  sessions.clear();
  activePrompts.clear();
  generationCounters.clear();
  turnStates.clear();
  visibleConversationOwners.clear();
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(GENERATION_STORAGE_PREFIX)) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Session storage is optional in tests.
  }
}
