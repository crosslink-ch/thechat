import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runChatLoop } from "../core/loop";
import { useStreamingStore, updateStreamParts, recordToolCallStart } from "../stores/streaming";
import { useCodexAuthStore } from "../stores/codex-auth";
import { useAnthropicAuthStore } from "../stores/anthropic-auth";
import { error as logError, formatError } from "../log";
import { ProviderError } from "../core/errors";
import type { Provider } from "../core/errors";
import { saveImage, buildUserContent } from "../lib/images";
import type { ImageAttachment, ImageRef } from "../lib/images";
import type {
  Message,
  MessagePart,
  DbMessage,
  Conversation,
  AppConfig,
  ChatParams,
  ToolDefinition,
  StreamEvent,
} from "../core/types";

export interface ChatError {
  message: string;
  provider?: Provider;
  isAuth: boolean;
}

/** Build a ChatError from a StreamEvent error. */
function chatErrorFromEvent(event: StreamEvent & { type: "error" }): ChatError {
  return {
    message: event.error,
    provider: event.provider,
    isAuth: event.statusCode === 401 || event.statusCode === 403,
  };
}

/** Build a ChatError from a caught exception. */
function chatErrorFromException(e: unknown): ChatError {
  if (e instanceof ProviderError) {
    return { message: e.message, provider: e.provider, isAuth: e.isAuth };
  }
  return { message: formatError(e), isAuth: false };
}

// -- DbMessage ↔ Message conversion --

function dbMessageToMessage(db: DbMessage): Message {
  // Try to parse content as MessagePart[] (new format)
  let parts: MessagePart[];
  try {
    const parsed = JSON.parse(db.content);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
      parts = parsed;
    } else {
      // Valid JSON but not parts format — treat as text
      parts = [{ type: "text", text: db.content }];
    }
  } catch {
    // Plain text content (legacy format)
    parts = [{ type: "text", text: db.content }];
  }

  // Prepend reasoning part if present
  if (db.reasoning_content) {
    parts = [{ type: "reasoning", text: db.reasoning_content }, ...parts];
  }

  return {
    id: db.id,
    conversation_id: db.conversation_id,
    role: db.role,
    parts,
    created_at: db.created_at,
  };
}

function messageToDbFields(msg: Message): { content: string; reasoningContent: string | null } {
  const reasoning = msg.parts.filter((p) => p.type === "reasoning");
  const nonReasoning = msg.parts.filter((p) => p.type !== "reasoning");

  const reasoningContent = reasoning.length > 0 ? reasoning.map((p) => p.text).join("") : null;

  // If only text parts (no tool or image parts), store as plain text for backward compat
  const hasOnlyText = nonReasoning.every((p) => p.type === "text");
  const content = hasOnlyText
    ? nonReasoning.map((p) => (p as { text: string }).text).join("")
    : JSON.stringify(nonReasoning);

  return { content, reasoningContent };
}

/** Convert a stored Message to an API-ready message object. */
async function messageToApiMessage(m: Message): Promise<Record<string, unknown>> {
  const imageParts = m.parts.filter((p) => p.type === "image") as Array<{
    type: "image";
    path: string;
    mimeType: string;
  }>;
  const textParts = m.parts.filter((p) => p.type === "text");
  const text = textParts.map((p) => (p as { text: string }).text).join("");

  if (imageParts.length === 0) {
    return { role: m.role, content: text };
  }

  // Has images — build content array with inline base64
  const refs: ImageRef[] = imageParts.map((p) => ({ path: p.path, mimeType: p.mimeType }));
  return { role: m.role, content: await buildUserContent(text, refs) };
}

interface UseChatOptions {
  tools?: ToolDefinition[];
  getTools?: () => ToolDefinition[];
  params?: ChatParams;
  systemPrompt?: string;
  projectDir?: string | null;
  onStreamComplete?: (convId: string, convTitle: string) => void;
}

export function useChat(options?: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<Array<{ id: string; content: string }>>([]);
  const queuedMessagesRef = useRef<Array<{ id: string; content: string }>>([]);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const sendMessageRef = useRef<(content: string) => Promise<void>>(null as any);
  const activeConvIdRef = useRef<string | null>(null);
  const onStreamCompleteRef = useRef(options?.onStreamComplete);
  onStreamCompleteRef.current = options?.onStreamComplete;
  const systemPromptRef = useRef(options?.systemPrompt);
  systemPromptRef.current = options?.systemPrompt;
  const projectDirRef = useRef(options?.projectDir);
  projectDirRef.current = options?.projectDir;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const clearQueue = useCallback(() => {
    queuedMessagesRef.current = [];
    setQueuedMessages([]);
  }, []);

  const loadConversation = useCallback(async (conv: Conversation) => {
    activeConvIdRef.current = conv.id;
    clearQueue();
    const dbMsgs = await invoke<DbMessage[]>("get_messages", {
      conversationId: conv.id,
    });
    setConversation(conv);
    setMessages(dbMsgs.map(dbMessageToMessage));
    setError(null);
  }, [clearQueue]);

  const startNewConversation = useCallback(() => {
    activeConvIdRef.current = null;
    clearQueue();
    setConversation(null);
    setMessages([]);
    setError(null);
  }, [clearQueue]);

  const sendMessage = useCallback(
    async (userContent: string, images?: ImageAttachment[]) => {
      if (!userContent.trim() && (!images || images.length === 0)) return;
      // Queue message if conversation is already streaming
      if (conversation && useStreamingStore.getState().streamingConvIds.has(conversation.id)) {
        const qm = { id: crypto.randomUUID(), content: userContent.trim() };
        queuedMessagesRef.current = [...queuedMessagesRef.current, qm];
        setQueuedMessages(queuedMessagesRef.current);
        return;
      }

      setError(null);
      let streamConvId: string | null = null;
      let streamConvTitle = "";

      try {
        const config = await invoke<AppConfig>("get_config");

        // Create conversation if needed
        let conv = conversation;
        if (!conv) {
          const titleText = userContent.trim() || (images?.length ? "Image conversation" : "New conversation");
          const title =
            titleText.length > 50 ? titleText.substring(0, 50) + "..." : titleText;
          const pDir = projectDirRef.current ?? undefined;
          conv = await invoke<Conversation>("create_conversation", {
            title,
            projectDir: pDir || null,
          });
          setConversation(conv);
          activeConvIdRef.current = conv.id;
        }

        streamConvId = conv.id;
        streamConvTitle = conv.title;

        // Mark this conversation as streaming
        useStreamingStore.getState().startStreaming(streamConvId);

        // Save images to disk if present
        let imageRefs: ImageRef[] | undefined;
        if (images && images.length > 0) {
          imageRefs = await Promise.all(
            images.map(async (img) => {
              const path = await saveImage(conv!.id, img);
              return { path, mimeType: img.mimeType };
            }),
          );
        }

        // Build user message parts for DB (text + image file refs)
        const userParts: MessagePart[] = [];
        if (userContent.trim()) {
          userParts.push({ type: "text", text: userContent });
        }
        if (imageRefs) {
          for (const ref_ of imageRefs) {
            userParts.push({ type: "image", path: ref_.path, mimeType: ref_.mimeType });
          }
        }

        // Save user message to DB (images stored as file path refs, not base64)
        const dbContent = userParts.length === 1 && userParts[0].type === "text"
          ? userContent
          : JSON.stringify(userParts);
        const userDbMsg = await invoke<DbMessage>("save_message", {
          conversationId: conv.id,
          role: "user",
          content: dbContent,
          reasoningContent: null,
        });
        const userMsg = dbMessageToMessage(userDbMsg);
        setMessages((prev) => [...prev, userMsg]);

        // Build API messages from current messages + new user message
        const apiMessages: Array<Record<string, unknown>> = [];
        for (const m of messagesRef.current) {
          apiMessages.push(await messageToApiMessage(m));
        }
        apiMessages.push({
          role: "user" as const,
          content: await buildUserContent(userContent, imageRefs),
        });

        // Start streaming
        const controller = new AbortController();
        abortControllersRef.current.set(streamConvId, controller);

        const streamingParts: MessagePart[] = [];

        const onEvents = (events: StreamEvent[]) => {
          let partsChanged = false;
          for (const event of events) {
            switch (event.type) {
              case "text-delta": {
                const lastPart = streamingParts[streamingParts.length - 1];
                if (lastPart && lastPart.type === "text") {
                  lastPart.text += event.text;
                } else {
                  streamingParts.push({ type: "text", text: event.text });
                }
                partsChanged = true;
                break;
              }
              case "reasoning-delta": {
                const lastPart = streamingParts[streamingParts.length - 1];
                if (lastPart && lastPart.type === "reasoning") {
                  lastPart.text += event.text;
                } else {
                  const insertIdx = streamingParts.findIndex((p) => p.type !== "reasoning");
                  if (insertIdx === -1) {
                    streamingParts.push({ type: "reasoning", text: event.text });
                  } else {
                    streamingParts.splice(insertIdx, 0, { type: "reasoning", text: event.text });
                  }
                }
                partsChanged = true;
                break;
              }
              case "tool-call-start":
                streamingParts.push({
                  type: "tool-call",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: {},
                });
                recordToolCallStart(streamConvId!, event.toolCallId);
                partsChanged = true;
                break;
              case "tool-call-complete": {
                const tc = streamingParts.find(
                  (p) => p.type === "tool-call" && p.toolCallId === event.toolCallId,
                );
                if (tc && tc.type === "tool-call") {
                  tc.args = event.args;
                }
                partsChanged = true;
                break;
              }
              case "tool-result":
                streamingParts.push({
                  type: "tool-result",
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  result: event.result,
                  isError: event.isError,
                });
                partsChanged = true;
                break;
              case "queued-message-consumed": {
                const qmEvent = event;
                invoke<DbMessage>("save_message", {
                  conversationId: streamConvId!,
                  role: "user",
                  content: qmEvent.content,
                  reasoningContent: null,
                }).then((dbMsg) => {
                  const msg = dbMessageToMessage(dbMsg);
                  if (activeConvIdRef.current === streamConvId) {
                    setMessages((prev) => [...prev, msg]);
                  }
                });
                // Remove from queued messages UI state
                setQueuedMessages((prev) => prev.filter((q) => q.id !== qmEvent.id));
                break;
              }
              case "error": {
                logError(`[useChat] Stream error (conv=${streamConvId}): ${event.error}`);
                const chatErr = chatErrorFromEvent(event);
                if (activeConvIdRef.current === streamConvId) {
                  setError(chatErr);
                }
                if (chatErr.isAuth && chatErr.provider === "anthropic") {
                  useAnthropicAuthStore.setState({ status: "error", error: "Session expired. Please reconnect." });
                } else if (chatErr.isAuth && chatErr.provider === "codex") {
                  useCodexAuthStore.setState({ status: "error", error: "Session expired. Please reconnect." });
                }
                break;
              }
            }
          }
          // Single React update per batch instead of per event.
          // Pass streamingParts directly — updateStreamParts copies only
          // when there are active subscribers (foreground chat). Background
          // chats skip the copy entirely.
          if (partsChanged) {
            updateStreamParts(streamConvId!, streamingParts);
          }
        };

        // Resolve provider auth
        const provider = config.provider ?? "openrouter";
        let codexAuth: { accessToken: string; accountId: string } | undefined;
        let anthropicAuth: { accessToken: string } | undefined;
        if (provider === "codex") {
          codexAuth = await useCodexAuthStore.getState().getValidToken();
        }
        if (provider === "anthropic") {
          anthropicAuth = await useAnthropicAuthStore.getState().getValidToken();
        }

        const getQueuedMessages = () => {
          const msgs = queuedMessagesRef.current;
          if (msgs.length === 0) return [];
          queuedMessagesRef.current = [];
          setQueuedMessages([]);
          return msgs;
        };

        const convProjectDir = conv.project_dir ?? projectDirRef.current ?? undefined;
        const activeModel = config.providers[provider].model;
        const re = config.reasoningEffort;
        await runChatLoop({
          apiKey: config.api_key,
          model: activeModel,
          messages: apiMessages,
          systemPrompt: systemPromptRef.current,
          params: {
            ...(re ? { reasoning_effort: re, effort: re } : {}),
            ...options?.params,
          },
          tools: options?.tools,
          getTools: options?.getTools,
          signal: controller.signal,
          cwd: convProjectDir || undefined,
          convId: streamConvId!,
          provider: codexAuth ? "codex" : provider === "anthropic" ? "anthropic" : "openrouter",
          codexAuth,
          anthropicAuth,
          getQueuedMessages,
          onEvents,
        });

        // Build final message from accumulated parts and save to DB
        if (streamingParts.length > 0) {
          const finalMessage: Message = {
            id: "",
            conversation_id: conv.id,
            role: "assistant",
            parts: streamingParts,
            created_at: new Date().toISOString(),
          };
          const { content, reasoningContent } = messageToDbFields(finalMessage);
          const savedDb = await invoke<DbMessage>("save_message", {
            conversationId: conv.id,
            role: "assistant",
            content,
            reasoningContent,
          });
          const savedMsg = dbMessageToMessage(savedDb);
          // Only update UI state if still viewing this conversation
          if (activeConvIdRef.current === streamConvId) {
            setMessages((prev) => [...prev, savedMsg]);
          }
        }

        onStreamCompleteRef.current?.(streamConvId, streamConvTitle);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // User cancelled
        } else {
          logError(`[useChat] sendMessage failed (conv=${streamConvId}): ${formatError(e)}`);

          const chatErr = chatErrorFromException(e);
          if (chatErr.isAuth && chatErr.provider === "anthropic") {
            useAnthropicAuthStore.setState({ status: "error", error: "Session expired. Please reconnect." });
          } else if (chatErr.isAuth && chatErr.provider === "codex") {
            useCodexAuthStore.setState({ status: "error", error: "Session expired. Please reconnect." });
          }

          setError(chatErr);
          if (streamConvId) {
            onStreamCompleteRef.current?.(streamConvId, streamConvTitle);
          }
        }
      } finally {
        if (streamConvId) {
          useStreamingStore.getState().stopStreaming(streamConvId);
          abortControllersRef.current.delete(streamConvId);

          // If there are remaining queued messages after streaming ends,
          // auto-trigger a new sendMessage with combined content
          const remaining = queuedMessagesRef.current;
          if (remaining.length > 0) {
            queuedMessagesRef.current = [];
            setQueuedMessages([]);
            const combined = remaining.map((q) => q.content).join("\n\n");
            setTimeout(() => sendMessageRef.current?.(combined), 0);
          }
        }
      }
    },
    [conversation, options?.params, options?.tools, options?.getTools],
  );
  sendMessageRef.current = sendMessage;

  const stopStreaming = useCallback(() => {
    const convId = activeConvIdRef.current;
    if (convId) {
      abortControllersRef.current.get(convId)?.abort();
    }
  }, []);

  return {
    messages,
    conversation,
    error,
    queuedMessages,
    sendMessage,
    stopStreaming,
    loadConversation,
    startNewConversation,
  };
}
