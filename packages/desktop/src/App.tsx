import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useChat } from "./hooks/useChat";
import { useAuth } from "./hooks/useAuth";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useKeybindings } from "./hooks/useKeybindings";
import { useMcpTools } from "./hooks/useMcpTools";
import { useWebSocket } from "./hooks/useWebSocket";
import { useChannelChat } from "./hooks/useChannelChat";
import { ChatMessage, StreamingMessage } from "./ChatMessage";
import { CommandPalette } from "./CommandPalette";
import { TodoPanel } from "./TodoPanel";
import { Sidebar } from "./components/Sidebar";
import { InputBar } from "./components/InputBar";
import { ChannelChatView } from "./components/ChannelChatView";
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
  createSkillTool,
} from "./core/tools/index";
import { discoverSkills } from "./core/skills";
import { setBatchToolRegistry } from "./core/tools/batch";
import { setTaskRunnerConfig } from "./core/task-runner";
import { onPermissionRequest, type PermissionRequest } from "./core/permission";
import { onQuestionRequest } from "./core/question";
import { onTodoUpdate, resetTodos } from "./core/todo";
import { buildSystemPrompt } from "./core/system-prompt";
import type {
  AppConfig,
  Conversation,
  QuestionRequest,
  TodoItem,
} from "./core/types";
import type { SkillMeta } from "./core/skills/types";
import type {
  AuthUser,
  WorkspaceChannel,
  WorkspaceMember,
  ChatMessage as WsChatMessage,
} from "@thechat/shared";
import { api } from "./lib/api";
import "./App.css";

type ViewMode =
  | { type: "agent-chat" }
  | { type: "channel"; channelId: string; channelName: string }
  | { type: "dm"; conversationId: string; otherUser: AuthUser };

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
  const [skills, setSkills] = useState<SkillMeta[]>([]);

  const skillTool = useMemo(
    () => (skills.length > 0 ? createSkillTool(skills) : null),
    [skills],
  );

  const tools = useMemo(
    () => [...builtinTools, ...(skillTool ? [skillTool] : []), ...mcpTools],
    [skillTool, mcpTools],
  );

  const systemPrompt = useMemo(() => buildSystemPrompt(), []);

  // Unread agent chats (declared before useChat so onStreamComplete can reference them)
  const [unreadAgentChats, setUnreadAgentChats] = useState<Set<string>>(new Set());
  const activeAgentConvIdRef = useRef<string | null>(null);

  // ViewMode state (declared before useChat so onStreamComplete can reference viewModeRef)
  const [viewMode, setViewMode] = useState<ViewMode>({ type: "agent-chat" });
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  const {
    messages,
    conversation,
    streaming,
    isStreaming,
    streamingConvIds,
    error,
    sendMessage,
    stopStreaming,
    loadConversation,
    startNewConversation,
  } = useChat({
    tools,
    systemPrompt,
    onStreamComplete: (convId: string, convTitle: string) => {
      invoke<Conversation[]>("list_conversations").then(setConversations);
      const isViewingThisChat =
        viewModeRef.current.type === "agent-chat" &&
        activeAgentConvIdRef.current === convId;
      if (!isViewingThisChat) {
        setUnreadAgentChats((prev) => {
          const next = new Set(prev);
          next.add(convId);
          return next;
        });
        fireNotification("Agent Chat", `Response ready: ${convTitle}`);
      }
    },
  });

  // Keep ref in sync for onStreamComplete callback
  activeAgentConvIdRef.current = conversation?.id ?? null;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null);
  const [todosState, setTodosState] = useState<TodoItem[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Unread channels
  const [unreadChannels, setUnreadChannels] = useState<Set<string>>(new Set());

  // Typing indicators
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Notification permission state
  const [, setNotifPermission] = useState(false);

  // Currently viewed conversation ID for channel/dm views
  const currentConversationId =
    viewMode.type === "channel"
      ? viewMode.channelId
      : viewMode.type === "dm"
        ? viewMode.conversationId
        : null;

  const currentConversationIdRef = useRef(currentConversationId);
  currentConversationIdRef.current = currentConversationId;
  const userRef = useRef(user);
  userRef.current = user;

  // WebSocket callbacks
  const handleWsNewMessage = useCallback(
    (msg: WsChatMessage, conversationType: "direct" | "group") => {
      // If the message is for the currently viewed conversation, add it
      if (msg.conversationId === currentConversationIdRef.current) {
        channelChatRef.current?.addMessage(msg);
      } else {
        // Not viewing this conversation
        if (conversationType === "group") {
          // Mark channel as unread
          setUnreadChannels((prev) => {
            const next = new Set(prev);
            next.add(msg.conversationId);
            return next;
          });
        }
        if (
          conversationType === "direct" &&
          msg.senderId !== userRef.current?.id
        ) {
          // Fire native notification for DM
          fireNotification(msg.senderName, msg.content);
        }
      }

      // Clear typing indicator for this user
      setTypingUsers((prev) => {
        if (!prev.has(msg.senderId)) return prev;
        const next = new Map(prev);
        next.delete(msg.senderId);
        return next;
      });
    },
    []
  );

  const handleWsTyping = useCallback(
    (conversationId: string, userId: string, userName: string) => {
      if (conversationId !== currentConversationIdRef.current) return;
      setTypingUsers((prev) => {
        const next = new Map(prev);
        next.set(userId, userName);
        return next;
      });

      // Clear after 3s
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
        }, 3000)
      );
    },
    []
  );

  const { connected, sendMessage: wsSendMessage } = useWebSocket({
    token,
    onNewMessage: handleWsNewMessage,
    onTyping: handleWsTyping,
  });

  // Channel chat hook
  const channelChat = useChannelChat({
    conversationId: currentConversationId,
    token,
    wsSendMessage,
  });

  // Store ref for WS callback access
  const channelChatRef = useRef(channelChat);
  channelChatRef.current = channelChat;

  // Fire native notification
  async function fireNotification(title: string, body: string) {
    try {
      const { isPermissionGranted, requestPermission, sendNotification } =
        await import("@tauri-apps/plugin-notification");

      let permitted = await isPermissionGranted();
      if (!permitted) {
        const result = await requestPermission();
        permitted = result === "granted";
        setNotifPermission(permitted);
      }
      if (permitted) {
        sendNotification({ title, body });
      }
    } catch {
      // Plugin not available (e.g., in browser dev mode)
    }
  }

  // Handle channel selection
  const handleSelectChannel = useCallback(
    (channel: WorkspaceChannel) => {
      setViewMode({ type: "channel", channelId: channel.id, channelName: channel.name });
      setSidebarOpen(false);
      setTypingUsers(new Map());
      // Clear unread for this channel
      setUnreadChannels((prev) => {
        if (!prev.has(channel.id)) return prev;
        const next = new Set(prev);
        next.delete(channel.id);
        return next;
      });
    },
    []
  );

  // Handle DM selection
  const handleSelectDm = useCallback(
    async (member: WorkspaceMember) => {
      if (!token || !activeWorkspace) return;

      try {
        const { data, error } = await api.conversations.dm.post(
          { workspaceId: activeWorkspace.id, otherUserId: member.userId },
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (error) throw error;
        if (data && "id" in data) {
          setViewMode({
            type: "dm",
            conversationId: data.id!,
            otherUser: member.user,
          });
          setSidebarOpen(false);
          setTypingUsers(new Map());
        }
      } catch {
        // Failed to create/get DM
      }
    },
    [token, activeWorkspace]
  );

  // Handle switching back to agent chat
  const handleBackToAgentChat = useCallback(() => {
    setViewMode({ type: "agent-chat" });
    setTypingUsers(new Map());
    const convId = activeAgentConvIdRef.current;
    if (convId) {
      setUnreadAgentChats((prev) => {
        if (!prev.has(convId)) return prev;
        const next = new Set(prev);
        next.delete(convId);
        return next;
      });
    }
  }, []);

  // Discover skills on mount
  useEffect(() => {
    discoverSkills().then(setSkills).catch(() => {});
  }, []);

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

  // Auto-scroll on new content (agent chat)
  useEffect(() => {
    if (viewMode.type === "agent-chat") {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streaming, pendingPermission, viewMode.type]);

  const handleNewConversation = useCallback(() => {
    startNewConversation();
    setViewMode({ type: "agent-chat" });
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

  // Chat header title
  const chatTitle =
    viewMode.type === "channel"
      ? `# ${viewMode.channelName}`
      : viewMode.type === "dm"
        ? viewMode.otherUser.name
        : conversation?.title || "New Chat";

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        conversations={conversations}
        currentId={viewMode.type === "agent-chat" ? conversation?.id : undefined}
        user={user}
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        onClose={() => setSidebarOpen(false)}
        onNewChat={handleNewConversation}
        onSelectConversation={(conv) => {
          setViewMode({ type: "agent-chat" });
          loadConversation(conv);
          setSidebarOpen(false);
          setUnreadAgentChats((prev) => {
            if (!prev.has(conv.id)) return prev;
            const next = new Set(prev);
            next.delete(conv.id);
            return next;
          });
        }}
        onLoginClick={() => setAuthModalOpen(true)}
        onLogout={logout}
        onSelectWorkspace={selectWorkspace}
        onOpenWorkspaceModal={() => setWorkspaceModalOpen(true)}
        onSelectChannel={handleSelectChannel}
        onSelectDm={handleSelectDm}
        activeChannelId={viewMode.type === "channel" ? viewMode.channelId : null}
        activeDmUserId={viewMode.type === "dm" ? viewMode.otherUser.id : null}
        unreadChannels={unreadChannels}
        unreadAgentChats={unreadAgentChats}
        streamingConvIds={streamingConvIds}
      />

      <div className="chat-main">
        <div className="chat-header">
          <button className="menu-btn" onClick={() => setSidebarOpen(!sidebarOpen)}>
            &#9776;
          </button>
          {viewMode.type !== "agent-chat" && (
            <button className="back-btn" onClick={handleBackToAgentChat}>
              &larr;
            </button>
          )}
          <span className="chat-title">
            {chatTitle}
          </span>
          {viewMode.type !== "agent-chat" && connected && (
            <span className="ws-status ws-connected" />
          )}
        </div>

        {viewMode.type === "agent-chat" ? (
          <>
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
          </>
        ) : (
          <ChannelChatView
            messages={channelChat.messages}
            loading={channelChat.loading}
            typingUsers={typingUsers}
            onSend={channelChat.sendMessage}
          />
        )}
      </div>

      {paletteOpen && (
        <CommandPalette
          conversations={conversations}
          currentId={conversation?.id}
          unreadAgentChats={unreadAgentChats}
          streamingConvIds={streamingConvIds}
          onSelect={(conv) => {
            setViewMode({ type: "agent-chat" });
            loadConversation(conv);
            setPaletteOpen(false);
            setUnreadAgentChats((prev) => {
              if (!prev.has(conv.id)) return prev;
              const next = new Set(prev);
              next.delete(conv.id);
              return next;
            });
          }}
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
