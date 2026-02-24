import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate, useMatches } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useChat } from "../hooks/useChat";
import { useIsStreaming } from "../stores/streaming";
import { useToolsStore } from "../stores/tools";
import { useConversationsStore } from "../stores/conversations";
import { useKeybindings } from "../hooks/useKeybindings";
import { setAgentChatTitle, setAgentChatProjectDir } from "../components/ChatHeader";
import { ProjectPicker } from "../components/ProjectPicker";
import { ChatMessage, StreamingMessage } from "../ChatMessage";
import { TodoPanel } from "../TodoPanel";
import { InputBar } from "../components/InputBar";
import { usePermissionStore } from "../core/permission";
import { useQuestionStore } from "../core/question";
import { useTodoStore, EMPTY_TODOS } from "../core/todo";
import { consumePendingProjectDir } from "../commands";
import { buildSystemPrompt, type ProjectInfo } from "../core/system-prompt";
import { fireNotification } from "../lib/notifications";
import type { Conversation } from "../core/types";

export function AgentChatRoute() {
  const navigate = useNavigate();
  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const routeId = (lastMatch?.params as Record<string, string>)?.id as string | undefined;

  const getTools = useCallback(() => useToolsStore.getState().tools, []);

  // Project mode state (for new chats before conversation is created)
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);

  const activeAgentConvIdRef = useRef<string | null>(null);
  const appliedInitialProjectDir = useRef(false);

  // systemPrompt is initially computed with just projectDir (for new chats)
  // It gets updated reactively below when conversation.project_dir is available
  const systemPrompt = useMemo(
    () => buildSystemPrompt(projectDir ?? undefined, projectInfo ?? undefined),
    [projectDir, projectInfo],
  );

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
    projectDir,
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

  // Pending permission/question state lives in global stores (survives route transitions)
  const convId = conversation?.id;
  const pendingPermission = usePermissionStore((s) => convId ? s.pending[convId] ?? null : null);
  const pendingQuestion = useQuestionStore((s) => convId ? s.pending[convId] ?? null : null);
  const todosState = useTodoStore((s) => convId ? s.todos[convId] ?? EMPTY_TODOS : EMPTY_TODOS);

  const [showFeedbackInput, setShowFeedbackInput] = useState(false);
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
          setProjectDir(conv.project_dir ?? null);
          useConversationsStore.getState().markAgentChatRead(conv.id);
          useToolsStore.getState().setActiveConversation(conv.id, conv.project_dir);
        }
      });
    } else if (!routeId && loadedIdRef.current !== null) {
      loadedIdRef.current = null;
      startNewConversation();
      const inherited = consumePendingProjectDir();
      setProjectDir(inherited);
      setProjectInfo(null);
      useToolsStore.getState().setActiveConversation(null);
    }
  }, [routeId, loadConversation, startNewConversation]);

  // Apply CLI project dir for new chats (once per app session)
  useEffect(() => {
    if (routeId || appliedInitialProjectDir.current) return;
    appliedInitialProjectDir.current = true;
    invoke<string | null>("get_initial_project_dir").then((dir) => {
      if (dir) setProjectDir(dir);
    });
  }, [routeId]);

  // Update URL when new conversation is created
  const prevConvId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (conversation?.id && !routeId && conversation.id !== prevConvId.current) {
      prevConvId.current = conversation.id;
      loadedIdRef.current = conversation.id;
      navigate({ to: "/chat/$id", params: { id: conversation.id }, replace: true });
      // New conversation just created — no tools to load, but set active conv for future skill calls
      useToolsStore.getState().setActiveConversation(conversation.id, conversation.project_dir);
    } else {
      prevConvId.current = conversation?.id;
    }
  }, [conversation?.id, routeId, navigate]);

  // Fetch git info when projectDir changes
  useEffect(() => {
    if (projectDir) {
      invoke<{ is_git: boolean; git_branch: string | null }>("get_project_info", {
        path: projectDir,
      })
        .then((info) =>
          setProjectInfo({ isGit: info.is_git, gitBranch: info.git_branch ?? undefined }),
        )
        .catch(() => setProjectInfo(null));
    } else {
      setProjectInfo(null);
    }
  }, [projectDir]);

  // Sync title and project dir to ChatHeader
  useEffect(() => {
    setAgentChatTitle(conversation?.title || "New Chat");
    setAgentChatProjectDir(projectDir);
  }, [conversation?.title, projectDir]);

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
      setShowFeedbackInput(false);
    }
  }, [pendingPermission]);

  const handlePermissionDeny = useCallback(() => {
    if (pendingPermission) {
      pendingPermission.reject("User denied permission");
      setShowFeedbackInput(false);
    }
  }, [pendingPermission]);

  const handlePermissionDenyWithFeedback = useCallback(
    (feedback: string) => {
      if (pendingPermission) {
        pendingPermission.reject(`User denied permission. User feedback: ${feedback}`);
        setShowFeedbackInput(false);
      }
    },
    [pendingPermission],
  );

  const handleQuestionSubmit = useCallback(
    (answers: string[][]) => {
      pendingQuestion?.resolve(answers);
    },
    [pendingQuestion],
  );

  const handleQuestionCancel = useCallback(() => {
    pendingQuestion?.reject("User cancelled");
  }, [pendingQuestion]);

  // Override keybindings for permission allow/deny
  useKeybindings({
    onPermissionAllow: pendingPermission ? handlePermissionAllow : null,
    onPermissionDeny: pendingPermission ? handlePermissionDeny : null,
    onPermissionDenyWithFeedback: pendingPermission ? () => setShowFeedbackInput(true) : null,
  });

  return (
    <>
      <TodoPanel todos={todosState} />

      <div className="flex flex-1 flex-col overflow-y-auto">
        {messages.length === 0 && !isStreaming && (
          <div className="flex flex-1 flex-col items-center justify-center text-base text-text-placeholder">
            <ProjectPicker
              projectDir={projectDir}
              onSelect={setProjectDir}
              readOnly={!!conversation?.project_dir}
            />
            <div style={{ marginTop: 12 }}>Send a message to start chatting</div>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <StreamingMessage
          convId={conversation?.id}
          pendingPermission={pendingPermission}
          onPermissionAllow={handlePermissionAllow}
          onPermissionDeny={handlePermissionDeny}
          onPermissionDenyWithFeedback={handlePermissionDenyWithFeedback}
          showFeedbackInput={showFeedbackInput}
          pendingQuestion={pendingQuestion}
          onQuestionSubmit={handleQuestionSubmit}
          onQuestionCancel={handleQuestionCancel}
        />
        {error && <div className="rounded-lg border border-error-msg-border bg-error-msg-bg px-3.5 py-2.5 text-[13px] text-error-bright">{error}</div>}
        <div ref={messagesEndRef} />
      </div>

      <InputBar
        convId={conversation?.id}
        onSend={sendMessage}
        onStop={stopStreaming}
      />
    </>
  );
}
