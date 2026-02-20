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

// -- MCP Tool Info (from backend) --

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
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

// -- Tool Definition --

export interface ToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: TArgs) => unknown | Promise<unknown>;
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

// -- Chat Loop Options --

export interface ChatLoopOptions {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  systemPrompt?: string;
  params?: ChatParams;
  tools?: ToolDefinition[];
  maxToolRoundtrips?: number;
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}
