import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => {
  class MockChannel {
    onmessage: ((data: unknown) => void) | null = null;
  }
  return {
    invoke: vi.fn(),
    Channel: MockChannel,
  };
});

import { invoke } from "@tauri-apps/api/core";
import { streamCodexCompletion } from "./codex";
import type { StreamResult } from "./types";

const mockInvoke = vi.mocked(invoke);

describe("streamCodexCompletion", () => {
  const mockResult: StreamResult = {
    text: "Hello world",
    reasoning: "",
    toolCalls: [],
    usage: undefined,
    stopReason: "stop",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes Codex responses headers and request shape to invoke", async () => {
    mockInvoke.mockResolvedValue(mockResult);

    await streamCodexCompletion({
      accessToken: "test-token",
      accountId: "acct_123",
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "hi" },
      ],
      convId: "conv_123",
      onEvents: () => {},
    });

    expect(mockInvoke).toHaveBeenCalledWith("stream_completion", expect.objectContaining({
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {
        Authorization: "Bearer test-token",
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "ChatGPT-Account-Id": "acct_123",
        "x-client-request-id": "conv_123",
        "session_id": "conv_123",
      },
      provider: "codex",
    }));

    const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>;
    const body = JSON.parse(callArgs.body as string);
    expect(body).toMatchObject({
      model: "gpt-5.4",
      instructions: "System prompt",
      stream: true,
      store: false,
      tool_choice: "auto",
      parallel_tool_calls: true,
      prompt_cache_key: "conv_123",
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "xhigh" },
    });
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ]);
  });

  it("maps tools and text controls into the responses request", async () => {
    mockInvoke.mockResolvedValue(mockResult);

    await streamCodexCompletion({
      accessToken: "test-token",
      accountId: "acct_123",
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hi" }],
      params: {
        reasoning_effort: "medium",
        verbosity: "low",
        service_tier: "priority",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "answer",
            strict: false,
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          },
        },
      },
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
          execute: async () => "ok",
        },
      ],
      onEvents: () => {},
    });

    const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>;
    const body = JSON.parse(callArgs.body as string);
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.service_tier).toBe("priority");
    expect(body.text).toEqual({
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "answer",
        strict: false,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  it("translates cancelled into AbortError", async () => {
    mockInvoke.mockRejectedValue("cancelled");

    await expect(
      streamCodexCompletion({
        accessToken: "test-token",
        accountId: "acct_123",
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hi" }],
        onEvents: () => {},
      }),
    ).rejects.toThrow("Aborted");
  });
});
