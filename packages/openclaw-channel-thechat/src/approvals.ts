import { buildSendTextRequest, type SendTextDeps } from "./outbound.js";
import type { TheChatChannelConfig, TheChatWebhookPayload } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  /** Unique, short identifier embedded in the chat message so replies can be
   *  correlated back to the original request.  Format: `APR-<hex>`. */
  id: string;
  /** The conversation where the approval prompt was posted. */
  conversationId: string;
  /** The OpenClaw target string (e.g. `channel:abc` or `dm:abc`). */
  to: string;
  /** Human-readable label for the action, e.g. `write /etc/config.yml`. */
  tool: string;
  /** Longer explanation shown in the approval message body. */
  description: string;
  /** Unix-ms timestamp when the request was created. */
  createdAt: number;
  /** Unix-ms timestamp after which the request auto-denies. */
  expiresAt: number;
}

export type ApprovalDecision = "approved" | "denied" | "expired";

export interface ApprovalOutcome {
  requestId: string;
  decision: ApprovalDecision;
  /** The TheChat user id that responded (absent for timeouts). */
  responderId?: string;
  /** Optional feedback the human typed alongside the denial. */
  feedback?: string;
}

export interface PendingApproval {
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
}

// ---------------------------------------------------------------------------
// Approval message formatting
// ---------------------------------------------------------------------------

const APPROVAL_TAG = "[APR-";

/**
 * Build the approval-request message posted to TheChat.  The embedded request
 * id lets `matchApprovalResponse` correlate a human reply back to this prompt.
 */
export function formatApprovalMessage(req: ApprovalRequest): string {
  const lines: string[] = [
    `**Approval Required** [${req.id}]`,
    "",
    `> \`${req.tool}\``,
  ];
  if (req.description) {
    lines.push(`> ${req.description}`);
  }
  lines.push(
    "",
    "Reply **approve** or **deny** (optionally with feedback)."
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Response matching
// ---------------------------------------------------------------------------

/** Canonical forms a human might type. Case-insensitive, trimmed.
 *  We use `(?=$|\s|\W)` instead of `\b` because `\b` doesn't match after emoji. */
const APPROVE_PATTERNS = /^\s*(approve|approved|yes|ok|y|✅|👍|lgtm)(?=$|\s|\W)/i;
const DENY_PATTERNS = /^\s*(deny|denied|reject|rejected|no|n|❌|👎)(?=$|\s|\W)/i;

export interface MatchResult {
  requestId: string;
  decision: "approved" | "denied";
  /** Any text after the keyword, trimmed. */
  feedback: string;
}

/**
 * Check whether `content` looks like a reply to an approval request.
 *
 * Two forms are supported:
 *   1. Explicit: the message quotes the request id — `APR-abc123 approve`
 *   2. Contextual: a bare `approve` / `deny` in a conversation that has
 *      exactly one pending approval request (the caller passes the id).
 *
 * Returns `null` if no match.
 */
export function matchApprovalResponse(
  content: string,
  pendingIds: string[]
): MatchResult | null {
  const trimmed = content.trim();
  if (trimmed.length === 0 || pendingIds.length === 0) return null;

  // 1. Explicit id reference — e.g. "APR-a1b2 approve" or "[APR-a1b2] deny reason"
  for (const id of pendingIds) {
    const tag = id; // e.g. "APR-a1b2c3"
    // Match the id anywhere in the message (people might quote it).
    if (trimmed.toUpperCase().includes(tag.toUpperCase())) {
      // Strip the id portion and try to find approve/deny in the remainder.
      const remainder = trimmed
        .replace(new RegExp(`\\[?${escapeRegex(tag)}\\]?`, "i"), "")
        .trim();
      const decision = parseDecision(remainder);
      if (decision) {
        return {
          requestId: id,
          decision: decision.decision,
          feedback: decision.feedback,
        };
      }
    }
  }

  // 2. Contextual — exactly one pending request, bare approve/deny keyword.
  if (pendingIds.length === 1) {
    const decision = parseDecision(trimmed);
    if (decision) {
      return {
        requestId: pendingIds[0],
        decision: decision.decision,
        feedback: decision.feedback,
      };
    }
  }

  return null;
}

function parseDecision(
  text: string
): { decision: "approved" | "denied"; feedback: string } | null {
  const approveMatch = APPROVE_PATTERNS.exec(text);
  if (approveMatch) {
    return {
      decision: "approved",
      feedback: text.slice(approveMatch[0].length).trim(),
    };
  }
  const denyMatch = DENY_PATTERNS.exec(text);
  if (denyMatch) {
    return {
      decision: "denied",
      feedback: text.slice(denyMatch[0].length).trim(),
    };
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// ApprovalRouter — stateful coordinator
// ---------------------------------------------------------------------------

export interface ApprovalRouterOptions {
  /** Default timeout for approval requests (ms). Default 300_000 (5 min). */
  defaultTimeoutMs?: number;
  /** Injectable clock for tests. Returns unix ms. */
  nowMs?: () => number;
}

export interface RequestApprovalOpts {
  /** OpenClaw target, e.g. `channel:abc123`. */
  to: string;
  /** Short tool label, e.g. `write /etc/config.yml`. */
  tool: string;
  /** Longer description of what the tool will do. */
  description: string;
  /** Per-request timeout override (ms). */
  timeoutMs?: number;
}

/**
 * Stateful approval router. Maintains an in-memory map of pending approvals
 * and correlates inbound TheChat messages to outstanding requests.
 *
 * Usage:
 *   const router = createApprovalRouter(config, opts);
 *   // When OpenClaw needs approval:
 *   const outcome = await router.requestApproval({ to, tool, description });
 *   // For every inbound webhook:
 *   const handled = router.handleInboundMessage(payload);
 */
export function createApprovalRouter(
  config: TheChatChannelConfig,
  opts: ApprovalRouterOptions & SendTextDeps = {}
) {
  const {
    defaultTimeoutMs = 300_000,
    nowMs = () => Date.now(),
    fetchImpl,
  } = opts;

  const pending = new Map<string, PendingApproval>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let idCounter = 0;

  function generateId(): string {
    idCounter += 1;
    const hex = ((nowMs() & 0xffffff) + idCounter).toString(16);
    return `APR-${hex}`;
  }

  /**
   * Post an approval-request message to TheChat and return a Promise that
   * resolves when the human responds (or the request expires).
   *
   * The pending entry is registered synchronously (before the network send)
   * so that `handleInboundMessage` can match responses even if a fast human
   * replies before `requestApproval` finishes its own I/O.
   */
  function requestApproval(
    reqOpts: RequestApprovalOpts
  ): Promise<ApprovalOutcome> {
    const id = generateId();
    const now = nowMs();
    const timeoutMs = reqOpts.timeoutMs ?? defaultTimeoutMs;

    const request: ApprovalRequest = {
      id,
      conversationId: "",
      to: reqOpts.to,
      tool: reqOpts.tool,
      description: reqOpts.description,
      createdAt: now,
      expiresAt: now + timeoutMs,
    };

    // Register the pending entry synchronously so getPending() and
    // handleInboundMessage() see it immediately.
    const outcomePromise = new Promise<ApprovalOutcome>((resolve) => {
      pending.set(id, { request, resolve });

      // Auto-expire after timeout.
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          timers.delete(id);
          resolve({ requestId: id, decision: "expired" });
        }
      }, timeoutMs);
      timers.set(id, timer);
    });

    // Fire-and-forget the message send.  If it fails we clean up the pending
    // entry and reject the caller's promise with the send error.
    const text = formatApprovalMessage(request);
    const prepared = buildSendTextRequest({ config, to: reqOpts.to, text });
    const fetcher = fetchImpl ?? globalThis.fetch;

    const sendPromise = fetcher(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
    }).then(async (res) => {
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        // Clean up — the request is dead.
        pending.delete(id);
        const timer = timers.get(id);
        if (timer) {
          clearTimeout(timer);
          timers.delete(id);
        }
        throw new Error(
          `thechat approvals: failed to post approval request ${id}: HTTP ${res.status} ${errBody.slice(0, 200)}`
        );
      }
      const data = (await res.json().catch(() => ({}))) as {
        conversationId?: string;
      };
      request.conversationId = data.conversationId ?? "";
    });

    // If the send fails, the rejection propagates to the caller.
    // If it succeeds, the caller waits for the approval outcome.
    return sendPromise.then(() => outcomePromise);
  }

  /**
   * Check an inbound message against pending approvals. Returns `true` if the
   * message was consumed as an approval response (i.e. should NOT be forwarded
   * to the OpenClaw runtime as a regular user message).
   */
  function handleInboundMessage(payload: TheChatWebhookPayload): boolean {
    if (pending.size === 0) return false;

    // Only accept responses from humans (prevents bot loops).
    if (payload.message.senderType !== "human") return false;

    // Collect pending ids for this conversation.
    const conversationPendingIds: string[] = [];
    for (const [id, p] of pending) {
      if (p.request.to.endsWith(payload.message.conversationId)) {
        conversationPendingIds.push(id);
      }
    }
    if (conversationPendingIds.length === 0) return false;

    const match = matchApprovalResponse(
      payload.message.content,
      conversationPendingIds
    );
    if (!match) return false;

    const entry = pending.get(match.requestId);
    if (!entry) return false;

    // Clean up.
    pending.delete(match.requestId);
    const timer = timers.get(match.requestId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(match.requestId);
    }

    entry.resolve({
      requestId: match.requestId,
      decision: match.decision,
      responderId: payload.message.senderId,
      feedback: match.feedback || undefined,
    });

    return true;
  }

  /** Snapshot of pending requests — useful for status/debug. */
  function getPending(): ApprovalRequest[] {
    return Array.from(pending.values()).map((p) => p.request);
  }

  /** Sweep expired requests that haven't been cleaned by their timers yet
   *  (defensive — timers should handle it, but this is safe to call). */
  function sweep(): number {
    const now = nowMs();
    let swept = 0;
    for (const [id, p] of pending) {
      if (now >= p.request.expiresAt) {
        pending.delete(id);
        const timer = timers.get(id);
        if (timer) {
          clearTimeout(timer);
          timers.delete(id);
        }
        p.resolve({ requestId: id, decision: "expired" });
        swept += 1;
      }
    }
    return swept;
  }

  /** Tear down all timers. Call when the plugin is being unloaded. */
  function dispose(): void {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    // Resolve any remaining pending as expired.
    for (const [id, p] of pending) {
      p.resolve({ requestId: id, decision: "expired" });
    }
    pending.clear();
  }

  return {
    requestApproval,
    handleInboundMessage,
    getPending,
    sweep,
    dispose,
  };
}

export type ApprovalRouter = ReturnType<typeof createApprovalRouter>;
