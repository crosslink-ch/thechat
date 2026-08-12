import { describe, expect, test } from "bun:test";
import { createLocalBotProgressStoreForTests } from "./bot-progress-store";

process.env.DATABASE_URL ??= "postgres://thechat:test@127.0.0.1:5432/thechat_test";
const { mapHermesRpcEvent, observePromiseRejection } = await import("./bot-runtime");

describe("Hermes RPC progress mapping", () => {
  test("maps message lifecycle and terminal final text", () => {
    expect(mapHermesRpcEvent(
      { type: "message.start", session_id: "runtime" },
      "runtime",
      1,
    )).toMatchObject({ type: "message.started", status: "running" });
    expect(mapHermesRpcEvent(
      { type: "message.delta", session_id: "runtime", payload: { text: "hel" } },
      "runtime",
      2,
    )).toMatchObject({ type: "message.delta", preview: "hel" });
    expect(mapHermesRpcEvent(
      { type: "message.complete", session_id: "runtime", payload: { text: "hello", status: "complete" } },
      "runtime",
      3,
    )).toMatchObject({
      type: "message.completed",
      status: "completed",
      terminal: { status: "completed", text: "hello" },
    });
  });

  test("uses stable upstream tool IDs and useful tool details", () => {
    const started = mapHermesRpcEvent(
      {
        type: "tool.start",
        session_id: "runtime",
        payload: { tool_id: "call-42", name: "terminal", context: "Run tests" },
      },
      "runtime",
      7,
    );
    const completed = mapHermesRpcEvent(
      {
        type: "tool.complete",
        session_id: "runtime",
        payload: { tool_id: "call-42", name: "terminal", summary: "Tests passed", duration_s: 1.5 },
      },
      "runtime",
      8,
    );
    expect(started).toMatchObject({
      type: "tool.started",
      toolCallId: "call-42",
      toolName: "terminal",
      label: "Run tests",
      payload: { upstreamEventIdentity: "runtime:tool.start:call-42" },
    });
    expect(completed).toMatchObject({
      type: "tool.completed",
      toolCallId: "call-42",
      label: "Tests passed",
      payload: { upstreamEventIdentity: "runtime:tool.complete:call-42", duration: 1.5 },
    });
  });

  test("maps interrupted and error terminals without inventing a final response", () => {
    expect(mapHermesRpcEvent(
      { type: "message.complete", payload: { status: "interrupted", text: "partial" } },
      "runtime",
      1,
    )?.terminal).toEqual({ status: "cancelled", text: "partial" });
    expect(mapHermesRpcEvent(
      { type: "error", payload: { message: "provider unavailable" } },
      "runtime",
      2,
    )?.terminal).toEqual({ status: "failed", error: "provider unavailable" });
  });

  test("allowlists tool payloads before progress persistence or fanout", async () => {
    const argsSecret = "ARGS_SENTINEL_SECRET";
    const resultSecret = "RESULT_SENTINEL_SECRET";
    const mapped = mapHermesRpcEvent(
      {
        type: "tool.complete",
        session_id: "runtime",
        payload: {
          tool_id: "call-secret",
          name: "terminal",
          context: "Run the focused check",
          summary: "Focused check passed",
          duration_s: 2.25,
          args: {
            command: "pnpm test focused",
            env: { PRIVATE_TOKEN: argsSecret },
            arbitrary: argsSecret,
          },
          result: { stdout: resultSecret, nested: { secret: resultSecret } },
          result_text: resultSecret,
          todos: [{ content: resultSecret }],
          inline_diff: resultSecret,
        },
      },
      "runtime",
      9,
    );
    expect(mapped).not.toBeNull();
    expect(mapped).toMatchObject({
      toolCallId: "call-secret",
      toolName: "terminal",
      label: "Focused check passed",
      payload: {
        upstreamEventIdentity: "runtime:tool.complete:call-secret",
        context: "Run the focused check",
        summary: "Focused check passed",
        duration: 2.25,
        args: { command: "pnpm test focused" },
      },
    });
    const mappedJson = JSON.stringify(mapped);
    expect(mappedJson).not.toContain(argsSecret);
    expect(mappedJson).not.toContain(resultSecret);
    expect(mappedJson).not.toContain("result_text");
    expect(mappedJson).not.toContain("inline_diff");

    const store = createLocalBotProgressStoreForTests();
    const stored = await store.append({
      invocationId: "invocation-secret",
      botId: "bot-secret",
      conversationId: "conversation-secret",
      threadId: null,
      type: mapped!.type,
      status: mapped!.status,
      toolCallId: mapped!.toolCallId,
      toolName: mapped!.toolName,
      label: mapped!.label,
      preview: mapped!.preview,
      payload: mapped!.payload,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(argsSecret);
    expect(serialized).not.toContain(resultSecret);
    expect(serialized).toContain("pnpm test focused");
  });

  test("observes an early terminal rejection while preserving a later rejected await", async () => {
    let rejectTerminal!: (error: Error) => void;
    const terminal = observePromiseRejection(new Promise<never>((_resolve, reject) => {
      rejectTerminal = reject;
    }));

    rejectTerminal(new Error("upstream disconnected before request failure surfaced"));
    await Promise.resolve();

    await expect(terminal).rejects.toThrow("upstream disconnected");
  });
});
