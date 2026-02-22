import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate, useMatches } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useChat } from "../hooks/useChat";
import { useIsStreaming } from "../stores/streaming";
import { useToolsStore } from "../stores/tools";
import { useConversationsStore } from "../stores/conversations";
import { useKeybindings } from "../hooks/useKeybindings";
import { togglePalette } from "../CommandPalette";
import { setAgentChatTitle } from "../components/ChatHeader";
import { ChatMessage, StreamingMessage } from "../ChatMessage";
import { TodoPanel } from "../TodoPanel";
import { InputBar } from "../components/InputBar";
import { QuestionOverlay } from "../components/QuestionOverlay";
import { onPermissionRequest, type PermissionRequest } from "../core/permission";
import { onQuestionRequest } from "../core/question";
import { onTodoUpdate, resetTodos } from "../core/todo";
import { buildSystemPrompt } from "../core/system-prompt";
import { fireNotification } from "../lib/notifications";
import type { Conversation, QuestionRequest, TodoItem } from "../core/types";

export function AgentChatRoute() {
  const navigate = useNavigate();
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const routeId = (lastMatch?.params as Record<string, string>)?.id as string | undefined;

  const getTools = useCallback(() => useToolsStore.getState().tools, []);
  const systemPrompt = useMemo(() => buildSystemPrompt(), []);

  const activeAgentConvIdRef = useRef<string | null>(null);

  const {
    messages,
    conversation,
    error,
    sendMessage,
    stopStreaming,
    loadConversation,
    startNewConversation,
  } = useChat({
    getTools,
    systemPrompt,
    onStreamComplete: (convId: string, convTitle: string) => {
      useConversationsStore.getState().fetchConversations();
      const isViewingThisChat = activeAgentConvIdRef.current === convId;
      if (!isViewingThisChat) {
        useConversationsStore.getState().markAgentChatUnread(convId);
        fireNotification("Agent Chat", `Response ready: ${convTitle}`);
      }
    },
  });

  const isStreaming = useIsStreaming(conversation?.id);

  // Keep ref in sync
  activeAgentConvIdRef.current = conversation?.id ?? null;

  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null);
  const [todosState, setTodosState] = useState<TodoItem[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load conversation from route param
  const loadedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (routeId && routeId !== loadedIdRef.current) {
      loadedIdRef.current = routeId;
      invoke<Conversation[]>("list_conversations").then((convs) => {
        const conv = convs.find((c) => c.id === routeId);
        if (conv) {
          loadConversation(conv);
          useConversationsStore.getState().markAgentChatRead(conv.id);
        }
      });
    } else if (!routeId && loadedIdRef.current !== null) {
      loadedIdRef.current = null;
      startNewConversation();
      resetTodos();
      setTodosState([]);
    }
  }, [routeId, loadConversation, startNewConversation]);

  // Update URL when new conversation is created
  const prevConvId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (conversation?.id && !routeId && conversation.id !== prevConvId.current) {
      prevConvId.current = conversation.id;
      loadedIdRef.current = conversation.id;
      navigate({ to: "/chat/$id", params: { id: conversation.id }, replace: true });
    } else {
      prevConvId.current = conversation?.id;
    }
  }, [conversation?.id, routeId, navigate]);

  // Subscribe to permission requests
  useEffect(() => {
    return onPermissionRequest((request) => {
      setPendingPermission(request);
    });
  }, []);

  // Subscribe to question requests
  useEffect(() => {
    return onQuestionRequest((request) => {
      setPendingQuestion(request);
    });
  }, []);

  // Subscribe to todo updates
  useEffect(() => {
    return onTodoUpdate((todos) => {
      setTodosState(todos);
    });
  }, []);

  // Sync title to ChatHeader
  useEffect(() => {
    setAgentChatTitle(conversation?.title || "New Chat");
  }, [conversation?.title]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingPermission]);

  // Fetch conversations list when conversation changes
  useEffect(() => {
    useConversationsStore.getState().fetchConversations();
  }, [conversation]);

  const handlePermissionAllow = useCallback(() => {
    if (pendingPermission) {
      pendingPermission.resolve();
      setPendingPermission(null);
    }
  }, [pendingPermission]);

  const handlePermissionDeny = useCallback(() => {
    if (pendingPermission) {
      pendingPermission.reject("User denied permission");
      setPendingPermission(null);
    }
  }, [pendingPermission]);

  const handleQuestionSubmit = useCallback(
    (answers: string[][]) => {
      pendingQuestion?.resolve(answers);
      setPendingQuestion(null);
    },
    [pendingQuestion],
  );

  const handleQuestionCancel = useCallback(() => {
    pendingQuestion?.reject("User cancelled");
    setPendingQuestion(null);
  }, [pendingQuestion]);

  // Override keybindings for permission allow/deny
  useKeybindings({
    onNewChat: () => {
      resetTodos();
      setTodosState([]);
      navigate({ to: "/chat" });
    },
    onPaletteToggle: togglePalette,
    onPermissionAllow: pendingPermission ? handlePermissionAllow : null,
    onPermissionDeny: pendingPermission ? handlePermissionDeny : null,
  });

  return (
    <>
      <TodoPanel todos={todosState} />

      <div className="messages-area">
        {messages.length === 0 && !isStreaming && (
          <div className="empty-state">Send a message to start chatting</div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <StreamingMessage
          convId={conversation?.id}
          pendingPermission={pendingPermission}
          onPermissionAllow={handlePermissionAllow}
          onPermissionDeny={handlePermissionDeny}
        />
        {error && <div className="error-message">{error}</div>}
        <div ref={messagesEndRef} />
      </div>

      {pendingQuestion && (
        <QuestionOverlay
          request={pendingQuestion}
          onSubmit={handleQuestionSubmit}
          onCancel={handleQuestionCancel}
        />
      )}

      <InputBar
        convId={conversation?.id}
        onSend={sendMessage}
        onStop={stopStreaming}
      />
    </>
  );
}
