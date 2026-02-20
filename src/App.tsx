import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useChat } from "./hooks/useChat";
import { ChatMessage, StreamingMessage } from "./ChatMessage";
import { CommandPalette } from "./CommandPalette";
import { TodoPanel } from "./TodoPanel";
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
import type { AppConfig, Conversation, McpToolInfo, QuestionRequest, TodoItem, ToolDefinition } from "./core/types";
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
  const [mcpTools, setMcpTools] = useState<ToolDefinition[]>([]);

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

  const [input, setInput] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null);
  const [questionAnswers, setQuestionAnswers] = useState<string[][]>([]);
  const [customInputs, setCustomInputs] = useState<string[]>([]);
  const [todosState, setTodosState] = useState<TodoItem[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      .catch(() => {
        // Config not yet available, will be set when available
      });
  }, [tools]);

  // Initialize MCP servers — tools arrive incrementally via events
  useEffect(() => {
    setMcpTools([]);

    const unlistenPromise = listen<McpToolInfo[]>("mcp-tools-ready", (event) => {
      const newTools: ToolDefinition[] = event.payload.map((info) => ({
        name: `${info.server}__${info.name}`,
        description: info.description,
        parameters: info.input_schema as Record<string, unknown>,
        execute: (args: Record<string, unknown>) =>
          invoke<string>("mcp_call_tool", {
            server: info.server,
            tool: info.name,
            args,
          }),
      }));
      setMcpTools((prev) => {
        const existing = new Set(prev.map((t) => t.name));
        const unique = newTools.filter((t) => !existing.has(t.name));
        return unique.length > 0 ? [...prev, ...unique] : prev;
      });
    });

    invoke("mcp_initialize").catch((e) =>
      console.error("MCP initialization failed:", e),
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      invoke("mcp_shutdown").catch(() => {});
    };
  }, []);

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
      setQuestionAnswers(request.questions.map(() => []));
      setCustomInputs(request.questions.map(() => ""));
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
  }, [messages, streaming]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, [input]);

  // Ctrl+P command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    const content = input;
    setInput("");
    sendMessage(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewConversation = useCallback(() => {
    startNewConversation();
    setSidebarOpen(false);
    resetTodos();
    setTodosState([]);
  }, [startNewConversation]);

  const handleQuestionSubmit = () => {
    if (!pendingQuestion) return;
    pendingQuestion.resolve(questionAnswers);
    setPendingQuestion(null);
  };

  const handleQuestionCancel = () => {
    if (!pendingQuestion) return;
    pendingQuestion.reject("User cancelled");
    setPendingQuestion(null);
  };

  const toggleQuestionOption = (qIndex: number, label: string) => {
    setQuestionAnswers((prev) => {
      const updated = [...prev];
      const current = updated[qIndex] ?? [];
      const isMultiple = pendingQuestion?.questions[qIndex]?.multiple;

      if (isMultiple) {
        if (current.includes(label)) {
          updated[qIndex] = current.filter((a) => a !== label);
        } else {
          updated[qIndex] = [...current, label];
        }
      } else {
        updated[qIndex] = [label];
      }
      return updated;
    });
  };

  const submitCustomAnswer = (qIndex: number) => {
    const text = customInputs[qIndex]?.trim();
    if (!text) return;
    setQuestionAnswers((prev) => {
      const updated = [...prev];
      const isMultiple = pendingQuestion?.questions[qIndex]?.multiple;
      if (isMultiple) {
        updated[qIndex] = [...(updated[qIndex] ?? []), text];
      } else {
        updated[qIndex] = [text];
      }
      return updated;
    });
    setCustomInputs((prev) => {
      const updated = [...prev];
      updated[qIndex] = "";
      return updated;
    });
  };

  return (
    <div className="app">
      {/* Sidebar overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <button className="new-chat-btn" onClick={handleNewConversation}>
          + New Chat
        </button>
        <div className="conversations-list">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              className={`conv-item ${conversation?.id === conv.id ? "conv-active" : ""}`}
              onClick={() => { loadConversation(conv); setSidebarOpen(false); }}
            >
              {conv.title}
            </button>
          ))}
        </div>
      </div>

      {/* Main chat area */}
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
            <StreamingMessage parts={streaming.parts} />
          )}
          {error && <div className="error-message">{error}</div>}
          <div ref={messagesEndRef} />
        </div>

        {pendingPermission && (
          <div className="permission-overlay">
            <div className="permission-card">
              <div className="permission-header">Run command?</div>
              <code className="permission-command">{pendingPermission.command}</code>
              {pendingPermission.description && (
                <div className="permission-desc">{pendingPermission.description}</div>
              )}
              <div className="permission-actions">
                <button
                  className="permission-btn permission-deny"
                  onClick={() => {
                    pendingPermission.reject("User denied permission");
                    setPendingPermission(null);
                  }}
                >
                  Deny
                </button>
                <button
                  className="permission-btn permission-allow"
                  onClick={() => {
                    pendingPermission.resolve();
                    setPendingPermission(null);
                  }}
                >
                  Allow
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingQuestion && (
          <div className="question-overlay">
            <div className="question-card">
              {pendingQuestion.questions.map((q, qIndex) => (
                <div key={qIndex} className="question-block">
                  <div className="question-header">{q.header}</div>
                  <div className="question-text">{q.question}</div>
                  <div className="question-options">
                    {q.options.map((opt) => {
                      const selected = (questionAnswers[qIndex] ?? []).includes(opt.label);
                      return (
                        <button
                          key={opt.label}
                          className={`question-option ${selected ? "question-option-selected" : ""}`}
                          onClick={() => toggleQuestionOption(qIndex, opt.label)}
                        >
                          <span className="question-option-label">{opt.label}</span>
                          <span className="question-option-desc">{opt.description}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="question-custom">
                    <input
                      type="text"
                      placeholder="Type your own answer..."
                      value={customInputs[qIndex] ?? ""}
                      onChange={(e) =>
                        setCustomInputs((prev) => {
                          const updated = [...prev];
                          updated[qIndex] = e.target.value;
                          return updated;
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          submitCustomAnswer(qIndex);
                        }
                      }}
                    />
                  </div>
                </div>
              ))}
              <div className="question-actions">
                <button className="permission-btn permission-deny" onClick={handleQuestionCancel}>
                  Cancel
                </button>
                <button className="permission-btn permission-allow" onClick={handleQuestionSubmit}>
                  Submit
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="input-bar">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <button className="send-btn stop-btn" onClick={stopStreaming}>
              Stop
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={handleSend}
              disabled={!input.trim()}
            >
              Send
            </button>
          )}
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette
          conversations={conversations}
          currentId={conversation?.id}
          onSelect={(conv) => { loadConversation(conv); setPaletteOpen(false); }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

export default App;
