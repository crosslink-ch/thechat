import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useChat } from "./hooks/useChat";
import { useAuth } from "./hooks/useAuth";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useKeybindings } from "./hooks/useKeybindings";
import { useMcpTools } from "./hooks/useMcpTools";
import { ChatMessage, StreamingMessage } from "./ChatMessage";
import { CommandPalette } from "./CommandPalette";
import { TodoPanel } from "./TodoPanel";
import { Sidebar } from "./components/Sidebar";
import { InputBar } from "./components/InputBar";
import { QuestionOverlay } from "./components/QuestionOverlay";
import { AuthModal } from "./components/AuthModal";
import { WorkspaceModal } from "./components/WorkspaceModal";
import {
  getCurrentTimeTool,
  shellTool,
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  globTool,
  grepTool,
  listTool,
  questionTool,
  batchTool,
  taskTool,
  todoReadTool,
  todoWriteTool,
  invalidTool,
} from "./core/tools/index";
import { setBatchToolRegistry } from "./core/tools/batch";
import { setTaskRunnerConfig } from "./core/task-runner";
import { onPermissionRequest, type PermissionRequest } from "./core/permission";
import { onQuestionRequest } from "./core/question";
import { onTodoUpdate, resetTodos } from "./core/todo";
import { buildSystemPrompt } from "./core/system-prompt";
import type { AppConfig, Conversation, QuestionRequest, TodoItem } from "./core/types";
import "./App.css";

const builtinTools = [
  getCurrentTimeTool,
  shellTool,
  readTool,
  writeTool,
  editTool,
  multiEditTool,
  globTool,
  grepTool,
  listTool,
  questionTool,
  batchTool,
  taskTool,
  todoReadTool,
  todoWriteTool,
  invalidTool,
];

function App() {
  const { user, token, login, register, logout } = useAuth();
  const {
    workspaces,
    activeWorkspace,
    selectWorkspace,
    createWorkspace,
    joinWorkspace,
  } = useWorkspaces(user, token);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const mcpTools = useMcpTools();

  const tools = useMemo(
    () => [...builtinTools, ...mcpTools],
    [mcpTools],
  );

  const systemPrompt = useMemo(() => buildSystemPrompt(), []);

  const {
    messages,
    conversation,
    streaming,
    isStreaming,
    error,
    sendMessage,
    stopStreaming,
    loadConversation,
    startNewConversation,
  } = useChat({ tools, systemPrompt });

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null);
  const [todosState, setTodosState] = useState<TodoItem[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Update batch tool registry when tools change
  useEffect(() => {
    setBatchToolRegistry(tools);
  }, [tools]);

  // Initialize task runner config
  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then((config) => {
        setTaskRunnerConfig({
          apiKey: config.api_key,
          model: config.model,
          availableTools: tools,
        });
      })
      .catch(() => {});
  }, [tools]);

  // Subscribe to permission requests from tool execution
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

  // Load conversations list
  useEffect(() => {
    invoke<Conversation[]>("list_conversations").then(setConversations);
  }, [conversation]);

  // Auto-scroll on new content
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming, pendingPermission]);

  const handleNewConversation = useCallback(() => {
    startNewConversation();
    setSidebarOpen(false);
    resetTodos();
    setTodosState([]);
  }, [startNewConversation]);

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

  useKeybindings({
    onNewChat: handleNewConversation,
    onPaletteToggle: () => setPaletteOpen((open) => !open),
    onPermissionAllow: pendingPermission ? handlePermissionAllow : null,
    onPermissionDeny: pendingPermission ? handlePermissionDeny : null,
  });

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        conversations={conversations}
        currentId={conversation?.id}
        user={user}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        onClose={() => setSidebarOpen(false)}
        onNewChat={handleNewConversation}
        onSelectConversation={(conv) => { loadConversation(conv); setSidebarOpen(false); }}
        onLoginClick={() => setAuthModalOpen(true)}
        onLogout={logout}
        onSelectWorkspace={selectWorkspace}
        onOpenWorkspaceModal={() => setWorkspaceModalOpen(true)}
      />

      <div className="chat-main">
        <div className="chat-header">
          <button className="menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
            &#9776;
          </button>
          <span className="chat-title">
            {conversation?.title || "New Chat"}
          </span>
        </div>

        <TodoPanel todos={todosState} />

        <div className="messages-area">
          {messages.length === 0 && !streaming && (
            <div className="empty-state">Send a message to start chatting</div>
          )}
          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
          {streaming && (
            <StreamingMessage
              parts={streaming.parts}
              pendingPermission={pendingPermission}
              onPermissionAllow={handlePermissionAllow}
              onPermissionDeny={handlePermissionDeny}
            />
          )}
          {error && <div className="error-message">{error}</div>}
          <div ref={messagesEndRef} />
        </div>

        {pendingQuestion && (
          <QuestionOverlay
            request={pendingQuestion}
            onSubmit={(answers) => { pendingQuestion.resolve(answers); setPendingQuestion(null); }}
            onCancel={() => { pendingQuestion.reject("User cancelled"); setPendingQuestion(null); }}
          />
        )}

        <InputBar
          isStreaming={isStreaming}
          onSend={sendMessage}
          onStop={stopStreaming}
        />
      </div>

      {paletteOpen && (
        <CommandPalette
          conversations={conversations}
          currentId={conversation?.id}
          onSelect={(conv) => { loadConversation(conv); setPaletteOpen(false); }}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {authModalOpen && (
        <AuthModal
          onLogin={login}
          onRegister={register}
          onClose={() => setAuthModalOpen(false)}
        />
      )}

      {workspaceModalOpen && (
        <WorkspaceModal
          onCreateWorkspace={async (name) => { await createWorkspace(name); }}
          onJoinWorkspace={async (id) => { await joinWorkspace(id); }}
          onClose={() => setWorkspaceModalOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
