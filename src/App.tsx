import { useState, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useChat } from "./useChat";
import { MessageBubble, StreamingBubble } from "./MessageBubble";
import type { Conversation } from "./types";
import "./App.css";

function App() {
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
  } = useChat();

  const [input, setInput] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <div className="app">
      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <button className="new-chat-btn" onClick={() => { startNewConversation(); setSidebarOpen(false); }}>
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

        <div className="messages-area">
          {messages.length === 0 && !streaming && (
            <div className="empty-state">Send a message to start chatting</div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {streaming && (
            <StreamingBubble
              content={streaming.content}
              reasoning={streaming.reasoning}
            />
          )}
          {error && <div className="error-message">{error}</div>}
          <div ref={messagesEndRef} />
        </div>

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
    </div>
  );
}

export default App;
