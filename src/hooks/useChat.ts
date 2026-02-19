import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runChatLoop } from "../core/loop";
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

// -- Streaming state shape --

interface StreamingState {
  parts: MessagePart[];
}

interface UseChatOptions {
  tools?: ToolDefinition[];
  params?: ChatParams;
}

export function useChat(options?: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadConversation = useCallback(async (conv: Conversation) => {
    const dbMsgs = await invoke<DbMessage[]>("get_messages", {
      conversationId: conv.id,
    });
    setConversation(conv);
    setMessages(dbMsgs.map(dbMessageToMessage));
    setError(null);
  }, []);

  const startNewConversation = useCallback(() => {
    setConversation(null);
    setMessages([]);
    setError(null);
    setStreaming(null);
  }, []);

  const sendMessage = useCallback(
    async (userContent: string) => {
      if (isStreaming || !userContent.trim()) return;

      setError(null);
      setIsStreaming(true);

      try {
        const config = await invoke<AppConfig>("get_config");

        // Create conversation if needed
        let conv = conversation;
        if (!conv) {
          const title =
            userContent.length > 50 ? userContent.substring(0, 50) + "..." : userContent;
          conv = await invoke<Conversation>("create_conversation", { title });
          setConversation(conv);
        }

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
          ...messages.map((m) => {
            const textParts = m.parts.filter((p) => p.type === "text");
            return { role: m.role, content: textParts.map((p) => p.text).join("") };
          }),
          { role: "user" as const, content: userContent },
        ];

        // Start streaming
        const controller = new AbortController();
        abortRef.current = controller;

        const streamingParts: MessagePart[] = [];
        setStreaming({ parts: [] });

        const onEvent = (event: StreamEvent) => {
          switch (event.type) {
            case "text-delta": {
              const lastPart = streamingParts[streamingParts.length - 1];
              if (lastPart && lastPart.type === "text") {
                lastPart.text += event.text;
              } else {
                streamingParts.push({ type: "text", text: event.text });
              }
              setStreaming({ parts: [...streamingParts] });
              break;
            }
            case "reasoning-delta": {
              const lastPart = streamingParts[streamingParts.length - 1];
              if (lastPart && lastPart.type === "reasoning") {
                lastPart.text += event.text;
              } else {
                // Insert reasoning before text parts
                const insertIdx = streamingParts.findIndex((p) => p.type !== "reasoning");
                if (insertIdx === -1) {
                  streamingParts.push({ type: "reasoning", text: event.text });
                } else {
                  streamingParts.splice(insertIdx, 0, { type: "reasoning", text: event.text });
                }
              }
              setStreaming({ parts: [...streamingParts] });
              break;
            }
            case "tool-call-start":
              streamingParts.push({
                type: "tool-call",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: {},
              });
              setStreaming({ parts: [...streamingParts] });
              break;
            case "tool-call-complete": {
              const tc = streamingParts.find(
                (p) => p.type === "tool-call" && p.toolCallId === event.toolCallId,
              );
              if (tc && tc.type === "tool-call") {
                tc.args = event.args;
              }
              setStreaming({ parts: [...streamingParts] });
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
              setStreaming({ parts: [...streamingParts] });
              break;
            case "error":
              setError(event.error);
              break;
          }
        };

        await runChatLoop({
          apiKey: config.api_key,
          model: config.model,
          messages: apiMessages,
          params: options?.params,
          tools: options?.tools,
          signal: controller.signal,
          onEvent,
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
          setMessages((prev) => [...prev, savedMsg]);
        }
        setStreaming(null);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // User cancelled
        } else {
          setError(String(e));
        }
        setStreaming(null);
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [conversation, messages, isStreaming, options?.params, options?.tools],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    messages,
    conversation,
    streaming,
    isStreaming,
    error,
    sendMessage,
    stopStreaming,
    loadConversation,
    startNewConversation,
  };
}
