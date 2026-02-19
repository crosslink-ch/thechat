import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Message, Conversation, AppConfig } from "./types";

interface StreamingMessage {
  content: string;
  reasoning: string;
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [streaming, setStreaming] = useState<StreamingMessage | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadConversation = useCallback(async (conv: Conversation) => {
    const msgs = await invoke<Message[]>("get_messages", {
      conversationId: conv.id,
    });
    setConversation(conv);
    setMessages(msgs);
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
        // Load config
        const config = await invoke<AppConfig>("get_config");

        // Create conversation if needed
        let conv = conversation;
        if (!conv) {
          const title =
            userContent.length > 50
              ? userContent.substring(0, 50) + "..."
              : userContent;
          conv = await invoke<Conversation>("create_conversation", { title });
          setConversation(conv);
        }

        // Save user message to DB
        const userMsg = await invoke<Message>("save_message", {
          conversationId: conv.id,
          role: "user",
          content: userContent,
          reasoningContent: null,
        });
        setMessages((prev) => [...prev, userMsg]);

        // Build messages array for API
        const apiMessages = [
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: "user" as const, content: userContent },
        ];

        // Start streaming from OpenRouter
        const controller = new AbortController();
        abortRef.current = controller;

        const response = await fetch(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.api_key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: config.model,
              messages: apiMessages,
              stream: true,
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`OpenRouter API error (${response.status}): ${errBody}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let accContent = "";
        let accReasoning = "";
        let buffer = "";

        setStreaming({ content: "", reasoning: "" });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          // Keep the last potentially incomplete line in the buffer
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (!delta) continue;

              if (delta.reasoning) {
                accReasoning += delta.reasoning;
              }
              // Handle reasoning_details array (thought-signature models)
              if (delta.reasoning_details) {
                for (const detail of delta.reasoning_details) {
                  if (detail.type === "thinking" && detail.thinking) {
                    accReasoning += detail.thinking;
                  }
                }
              }
              if (delta.content) {
                accContent += delta.content;
              }

              setStreaming({
                content: accContent,
                reasoning: accReasoning,
              });
            } catch {
              // Skip malformed JSON chunks
            }
          }
        }

        // Save assistant message to DB
        const assistantMsg = await invoke<Message>("save_message", {
          conversationId: conv.id,
          role: "assistant",
          content: accContent,
          reasoningContent: accReasoning || null,
        });
        setMessages((prev) => [...prev, assistantMsg]);
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
    [conversation, messages, isStreaming],
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
