import { describe, test, expect } from "bun:test";
import {
  formatApprovalMessage,
  matchApprovalResponse,
  createApprovalRouter,
  type ApprovalOutcome,
} from "./approvals.js";
import type { TheChatChannelConfig, TheChatWebhookPayload } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConfig: TheChatChannelConfig = {
  baseUrl: "https://chat.example",
  botId: "bot-1",
  botUserId: "user-bot-1",
  apiKey: "bot_testkey",
  webhookSecret: "whsec_testsecret",
};

function makePayload(
  content: string,
  conversationId = "conv-1",
  senderId = "user-human-1"
): TheChatWebhookPayload {
  return {
    event: "direct_message",
    message: {
      id: `m-${Date.now()}`,
      content,
      conversationId,
      senderId,
      senderName: "Alice",
      senderType: "human",
      createdAt: new Date().toISOString(),
    },
    conversation: {
      id: conversationId,
      type: "direct",
      kind: "dm",
      name: null,
      workspaceId: "ws-1",
    },
    workspace: { id: "ws-1", name: "Test" },
    bot: { id: "bot-1", userId: "user-bot-1", name: "Bot" },
  };
}

/** Fake fetch that records calls and returns a canned response. */
function fakeFetch(status = 200, body: object = { id: "msg-1", conversationId: "conv-1" }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, impl: impl as typeof fetch };
}

// ---------------------------------------------------------------------------
// formatApprovalMessage
// ---------------------------------------------------------------------------

describe("formatApprovalMessage", () => {
  test("includes the request id and tool name", () => {
    const msg = formatApprovalMessage({
      id: "APR-abc",
      conversationId: "conv-1",
      to: "dm:conv-1",
      tool: "write /etc/config.yml",
      description: "Overwrite production config",
      createdAt: 1000,
      expiresAt: 2000,
    });
    expect(msg).toContain("APR-abc");
    expect(msg).toContain("write /etc/config.yml");
    expect(msg).toContain("Overwrite production config");
    expect(msg).toContain("approve");
    expect(msg).toContain("deny");
  });

  test("omits description line when description is empty", () => {
    const msg = formatApprovalMessage({
      id: "APR-xyz",
      conversationId: "conv-1",
      to: "dm:conv-1",
      tool: "shell rm -rf /tmp/junk",
      description: "",
      createdAt: 1000,
      expiresAt: 2000,
    });
    expect(msg).toContain("APR-xyz");
    expect(msg).toContain("shell rm -rf /tmp/junk");
  });
});

// ---------------------------------------------------------------------------
// matchApprovalResponse
// ---------------------------------------------------------------------------

describe("matchApprovalResponse", () => {
  test("returns null on empty input", () => {
    expect(matchApprovalResponse("", ["APR-1"])).toBeNull();
    expect(matchApprovalResponse("approve", [])).toBeNull();
  });

  test("matches explicit id + approve", () => {
    const r = matchApprovalResponse("APR-abc approve", ["APR-abc", "APR-def"]);
    expect(r).toEqual({
      requestId: "APR-abc",
      decision: "approved",
      feedback: "",
    });
  });

  test("matches explicit id + deny with feedback", () => {
    const r = matchApprovalResponse("[APR-def] deny too risky", ["APR-abc", "APR-def"]);
    expect(r).toEqual({
      requestId: "APR-def",
      decision: "denied",
      feedback: "too risky",
    });
  });

  test("matches bare approve when exactly one pending", () => {
    const r = matchApprovalResponse("yes", ["APR-solo"]);
    expect(r).toEqual({
      requestId: "APR-solo",
      decision: "approved",
      feedback: "",
    });
  });

  test("matches bare deny when exactly one pending", () => {
    const r = matchApprovalResponse("no", ["APR-solo"]);
    expect(r).toEqual({
      requestId: "APR-solo",
      decision: "denied",
      feedback: "",
    });
  });

  test("does not match bare keyword when multiple pending", () => {
    const r = matchApprovalResponse("approve", ["APR-1", "APR-2"]);
    expect(r).toBeNull();
  });

  test("is case-insensitive for keywords", () => {
    expect(matchApprovalResponse("APPROVE", ["APR-1"])?.decision).toBe("approved");
    expect(matchApprovalResponse("Deny", ["APR-1"])?.decision).toBe("denied");
    expect(matchApprovalResponse("YES", ["APR-1"])?.decision).toBe("approved");
    expect(matchApprovalResponse("Rejected", ["APR-1"])?.decision).toBe("denied");
  });

  test("matches emoji responses", () => {
    expect(matchApprovalResponse("✅", ["APR-1"])?.decision).toBe("approved");
    expect(matchApprovalResponse("❌", ["APR-1"])?.decision).toBe("denied");
    expect(matchApprovalResponse("👍", ["APR-1"])?.decision).toBe("approved");
    expect(matchApprovalResponse("👎", ["APR-1"])?.decision).toBe("denied");
  });

  test("matches lgtm as approval", () => {
    expect(matchApprovalResponse("lgtm", ["APR-1"])?.decision).toBe("approved");
  });

  test("returns null for unrelated messages", () => {
    expect(matchApprovalResponse("hello world", ["APR-1"])).toBeNull();
    expect(matchApprovalResponse("what does this do?", ["APR-1"])).toBeNull();
  });

  test("id match is case-insensitive", () => {
    const r = matchApprovalResponse("apr-abc approve", ["APR-abc"]);
    expect(r?.requestId).toBe("APR-abc");
    expect(r?.decision).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// createApprovalRouter
// ---------------------------------------------------------------------------

describe("createApprovalRouter", () => {
  test("requestApproval sends message and returns pending promise", async () => {
    const { calls, impl } = fakeFetch();
    const router = createApprovalRouter(baseConfig, { fetchImpl: impl });

    // Start the approval (don't await yet).
    const promise = router.requestApproval({
      to: "dm:conv-1",
      tool: "write /tmp/test",
      description: "Create test file",
    });

    // Verify the approval message was sent.
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/messages/conv-1");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.content).toContain("Approval Required");
    expect(body.content).toContain("write /tmp/test");

    // Should have one pending approval.
    expect(router.getPending().length).toBe(1);

    // Simulate a human approval response.
    const pending = router.getPending()[0];
    const handled = router.handleInboundMessage(
      makePayload(`${pending.id} approve`)
    );
    expect(handled).toBe(true);

    const outcome = await promise;
    expect(outcome.decision).toBe("approved");
    expect(outcome.responderId).toBe("user-human-1");
    expect(router.getPending().length).toBe(0);
  });

  test("denial resolves with denied decision", async () => {
    const { impl } = fakeFetch();
    const router = createApprovalRouter(baseConfig, { fetchImpl: impl });

    const promise = router.requestApproval({
      to: "dm:conv-1",
      tool: "shell rm -rf /",
      description: "Dangerous command",
    });

    const pending = router.getPending()[0];
    router.handleInboundMessage(
      makePayload(`${pending.id} deny absolutely not`)
    );

    const outcome = await promise;
    expect(outcome.decision).toBe("denied");
    expect(outcome.feedback).toBe("absolutely not");
  });

  test("ignores messages from bots", () => {
    const { impl } = fakeFetch();
    const router = createApprovalRouter(baseConfig, { fetchImpl: impl });

    // Start an approval (fire-and-forget for this test).
    router.requestApproval({
      to: "dm:conv-1",
      tool: "write /tmp/x",
      description: "",
    });

    const botPayload = makePayload("approve", "conv-1", "user-bot-2");
    botPayload.message.senderType = "bot";
    const handled = router.handleInboundMessage(botPayload);
    expect(handled).toBe(false);
    expect(router.getPending().length).toBe(1);
  });

  test("ignores messages for other conversations", () => {
    const { impl } = fakeFetch();
    const router = createApprovalRouter(baseConfig, { fetchImpl: impl });

    router.requestApproval({
      to: "dm:conv-1",
      tool: "write /tmp/x",
      description: "",
    });

    const handled = router.handleInboundMessage(
      makePayload("approve", "conv-OTHER")
    );
    expect(handled).toBe(false);
  });

  test("timeout expires the approval", async () => {
    const { impl } = fakeFetch();
    let now = 1000;
    const router = createApprovalRouter(baseConfig, {
      fetchImpl: impl,
      nowMs: () => now,
      defaultTimeoutMs: 100,
    });

    const promise = router.requestApproval({
      to: "dm:conv-1",
      tool: "write /tmp/x",
      description: "",
    });

    // Wait slightly more than the timeout for the setTimeout to fire.
    const outcome = await promise;
    expect(outcome.decision).toBe("expired");
    expect(router.getPending().length).toBe(0);
  });

  test("sweep cleans expired requests", async () => {
    const { impl } = fakeFetch();
    let now = 1000;
    const router = createApprovalRouter(baseConfig, {
      fetchImpl: impl,
      nowMs: () => now,
      defaultTimeoutMs: 5000,
    });

    router.requestApproval({
      to: "dm:conv-1",
      tool: "write /tmp/x",
      description: "",
    });

    expect(router.getPending().length).toBe(1);

    // Advance time past the timeout.
    now = 7000;
    const swept = router.sweep();
    expect(swept).toBe(1);
    expect(router.getPending().length).toBe(0);
  });

  test("dispose clears all pending and resolves as expired", async () => {
    const { impl } = fakeFetch();
    const router = createApprovalRouter(baseConfig, { fetchImpl: impl });

    const p1 = router.requestApproval({ to: "dm:conv-1", tool: "a", description: "" });
    const p2 = router.requestApproval({ to: "dm:conv-1", tool: "b", description: "" });

    router.dispose();

    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1.decision).toBe("expired");
    expect(o2.decision).toBe("expired");
    expect(router.getPending().length).toBe(0);
  });

  test("contextual match works when only one approval in conversation", async () => {
    const { impl } = fakeFetch();
    const router = createApprovalRouter(baseConfig, { fetchImpl: impl });

    const promise = router.requestApproval({
      to: "dm:conv-1",
      tool: "write /tmp/x",
      description: "",
    });

    // Bare "yes" without the id — should match because only one pending.
    const handled = router.handleInboundMessage(makePayload("yes", "conv-1"));
    expect(handled).toBe(true);

    const outcome = await promise;
    expect(outcome.decision).toBe("approved");
  });

  test("throws when fetch fails to send the approval message", async () => {
    const { impl } = fakeFetch(500, { error: "Internal Server Error" });
    const router = createApprovalRouter(baseConfig, { fetchImpl: impl });

    await expect(
      router.requestApproval({
        to: "dm:conv-1",
        tool: "write /tmp/x",
        description: "",
      })
    ).rejects.toThrow("HTTP 500");
  });
});
