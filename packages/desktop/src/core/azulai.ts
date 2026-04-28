import { streamChatCompletion } from "./chat-completions";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";

interface StreamAzulaiOptions {
  apiUrl: string;
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvents: (events: StreamEvent[]) => void;
}

export async function streamAzulaiCompletion(options: StreamAzulaiOptions): Promise<StreamResult> {
  const { apiUrl, ...rest } = options;
  // AzulAI inference endpoint is OpenAI-compatible at /v1/inference
  const url = apiUrl.replace(/\/+$/, "") + "/v1/chat/completions";
  return streamChatCompletion({
    ...rest,
    url,
    providerTag: "azulai",
    streamIdPrefix: "az_",
  });
}
