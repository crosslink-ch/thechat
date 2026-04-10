import { streamChatCompletion } from "./chat-completions";
import type { ChatParams, StreamEvent, StreamResult, ToolDefinition } from "./types";
import type { GlmPlanType } from "@thechat/shared";

const GLM_ENDPOINTS: Record<GlmPlanType, string> = {
  coding: "https://api.z.ai/api/coding/paas/v4/chat/completions",
  standard: "https://api.z.ai/api/paas/v4/chat/completions",
};

interface StreamGlmOptions {
  apiKey: string;
  model: string;
  messages: Array<Record<string, unknown>>;
  params?: ChatParams;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onEvents: (events: StreamEvent[]) => void;
  planType?: GlmPlanType;
}

export async function streamGlmCompletion(options: StreamGlmOptions): Promise<StreamResult> {
  const { planType = "standard", ...rest } = options;
  return streamChatCompletion({
    ...rest,
    url: GLM_ENDPOINTS[planType],
    providerTag: "glm",
    streamIdPrefix: "glm_",
  });
}
