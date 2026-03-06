import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runChatLoop } from "../core/loop";
import { useStreamingStore, updateStreamParts } from "../stores/streaming";
import { useCodexAuthStore } from "../stores/codex-auth";
import { useAnthropicAuthStore } from "../stores/anthropic-auth";
import { error as logError, formatError } from "../log";
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

  // If only text parts (no tool parts), store as plain text for backward compat
  const hasOnlyText = nonReasoning.every((p) => p.type === "text");
  const content = hasOnlyText
    ? nonReasoning.map((p) => (p as { text: string }).text).join("")
    : JSON.stringify(nonReasoning);

  return { content, reasoningContent };
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
  const [error, setError] = useState<string | null>(null);
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
    async (userContent: string) => {
      if (!userContent.trim()) return;
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
          const title =
            userContent.length > 50 ? userContent.substring(0, 50) + "..." : userContent;
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

        // Save user message to DB
        const userDbMsg = await invoke<DbMessage>("save_message", {
          conversationId: conv.id,
          role: "user",
          content: userContent,
          reasoningContent: null,
        });
        const userMsg = dbMessageToMessage(userDbMsg);
        setMessages((prev) => [...prev, userMsg]);

        // Build API messages from current messages + new user message
        const apiMessages = [
          ...messagesRef.current.map((m) => {
            const textParts = m.parts.filter((p) => p.type === "text");
            return { role: m.role, content: textParts.map((p) => p.text).join("") };
          }),
          { role: "user" as const, content: userContent },
        ];

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
              case "error":
                logError(`[useChat] Stream error (conv=${streamConvId}): ${event.error}`);
                if (activeConvIdRef.current === streamConvId) {
                  setError(event.error);
                }
                break;
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

        // Resolve provider and codex auth
        const provider = config.provider ?? "openrouter";
        let codexAuth: { accessToken: string; accountId: string } | undefined;
        let anthropicAuth: { accessToken: string } | undefined;
        if (provider === "codex") {
          try {
            codexAuth = await useCodexAuthStore.getState().getValidToken();
          } catch (e) {
            logError(`[useChat] Codex auth failed, falling back to OpenRouter: ${formatError(e)}`);
          }
        }
        // Try Anthropic OAuth if provider is anthropic and OAuth is available
        if (provider === "anthropic" && useAnthropicAuthStore.getState().status === "authenticated") {
          try {
            anthropicAuth = await useAnthropicAuthStore.getState().getValidToken();
          } catch (e) {
            logError(`[useChat] Anthropic OAuth refresh failed, falling back to API key: ${formatError(e)}`);
          }
        }

        const getQueuedMessages = () => {
          const msgs = queuedMessagesRef.current;
          if (msgs.length === 0) return [];
          queuedMessagesRef.current = [];
          setQueuedMessages([]);
          return msgs;
        };

        const convProjectDir = conv.project_dir ?? projectDirRef.current ?? undefined;
        await runChatLoop({
          apiKey: config.api_key,
          model: config.model,
          messages: apiMessages,
          systemPrompt: systemPromptRef.current,
          params: options?.params,
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
          const msg = formatError(e);
          logError(`[useChat] sendMessage failed (conv=${streamConvId}): ${msg}`);
          setError(msg);
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
