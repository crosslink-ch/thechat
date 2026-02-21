// -- Message Parts (rich message model) --

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean };

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "tool";
  parts: MessagePart[];
  created_at: string;
}

// -- Database message shape (matches backend) --

export interface DbMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning_content: string | null;
  created_at: string;
}

// -- Conversation & Config --

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AppConfig {
  api_key: string;
  model: string;
}

// -- Todo Items --

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority?: "high" | "medium" | "low";
}

// -- Auth Types --

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface RegisterResponse {
  token?: string;
  user?: AuthUser;
  message?: string;
}

// -- Workspace Types --

export type WorkspaceMemberRole = "member" | "admin" | "owner";

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  userId: string;
  role: WorkspaceMemberRole;
  joinedAt: string;
  user: AuthUser;
}

export interface WorkspaceChannel {
  id: string;
  workspaceId: string;
  name: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceWithDetails extends Workspace {
  members: WorkspaceMember[];
  channels: WorkspaceChannel[];
}

export interface WorkspaceListItem extends Workspace {
  role: WorkspaceMemberRole;
}

// -- Chat Parameters --

export interface ChatParams {
  model?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  response_format?: {
    type: "json_schema";
    json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> };
  };
  reasoning_effort?: "low" | "medium" | "high";
  thinking?: { type: "enabled"; budget_tokens: number };
  seed?: number;
  provider?: { allow_fallbacks?: boolean; order?: string[] };
}

// -- Stream Events (core → UI callback) --

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string }
  | { type: "tool-call-args-delta"; toolCallId: string; args: string }
  | { type: "tool-call-complete"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "finish"; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: "error"; error: string };

// -- Stream Result (returned from streamCompletion) --

export interface ToolCallResult {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface StreamResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCallResult[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
