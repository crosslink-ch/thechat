/**
 * OpenClaw entry point for the TheChat channel plugin.
 *
 * Wires the real SDK shape:
 *   - `defineChannelPluginEntry` is the canonical channel-plugin entry helper.
 *   - `theChatChannelPlugin` (from `./src/channel.ts`) is built with
 *     `createChatChannelPlugin` and supplies the config + outbound surface.
 *   - `registerFull(...)` mounts the inbound webhook receiver. The pure
 *     `handleInbound` helper still lives in `./src/inbound.ts` so the
 *     verify → gate → mapping pipeline can be unit-tested without an
 *     OpenClaw runtime.
 *
 * Inbound dispatch: prefer any future runtime-level `dispatchInbound` helper,
 * then fall back to the current OpenClaw channel runtime primitives for route
 * resolution, session recording, reply dispatch, and outbound delivery.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import { recordInboundSessionAndDispatchReply } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  beginWebhookRequestPipelineOrReject,
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  readWebhookBodyOrReject,
  resolveRequestClientIp,
  WEBHOOK_BODY_READ_DEFAULTS,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import { CHANNEL_ID, theChatChannelPlugin } from "./src/channel.js";
import {
  resolveTheChatAccount,
  resolveAllTheChatAccounts,
  findAccountByBotId,
} from "./src/accounts.js";
import { handleInbound, type InboundOutcome } from "./src/inbound.js";
import { sendText, sendRichMessage, buildSendRichMessageRequest } from "./src/outbound.js";
import { deriveSessionMapping, parseTarget } from "./src/session.js";
import { shouldDispatch } from "./src/gating.js";
import { computeSignature, verifyWebhook } from "./src/signature.js";
import { validateConfig } from "./src/config-schema.js";
import {
  createApprovalRouter,
  formatApprovalMessage,
  matchApprovalResponse,
} from "./src/approvals.js";
import { runDoctorChecks, runMultiAccountDoctorChecks } from "./src/doctor.js";
import { createIdempotencyStore } from "./src/idempotency.js";
import type {
  TheChatChannelConfig,
  TheChatWebhookPayload,
  OutboundRichMessage,
  OutboundAttachment,
} from "./src/types.js";
import type {
  ApprovalRouter,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalOutcome,
} from "./src/approvals.js";
import type {
  DoctorResult,
  DoctorCheck,
  CheckStatus,
  MultiAccountDoctorResult,
} from "./src/doctor.js";
import type { IdempotencyStore } from "./src/idempotency.js";

export {
  CHANNEL_ID,
  theChatChannelPlugin,
  handleInbound,
  sendText,
  deriveSessionMapping,
  parseTarget,
  shouldDispatch,
  computeSignature,
  verifyWebhook,
  validateConfig,
  resolveTheChatAccount,
  // Phase 2
  createApprovalRouter,
  formatApprovalMessage,
  matchApprovalResponse,
  runDoctorChecks,
  // Phase 3
  resolveAllTheChatAccounts,
  findAccountByBotId,
  sendRichMessage,
  buildSendRichMessageRequest,
  runMultiAccountDoctorChecks,
  createIdempotencyStore,
};
export type {
  TheChatChannelConfig,
  TheChatWebhookPayload,
  // Phase 2
  ApprovalRouter,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalOutcome,
  DoctorResult,
  DoctorCheck,
  CheckStatus,
  // Phase 3
  OutboundRichMessage,
  OutboundAttachment,
  MultiAccountDoctorResult,
  IdempotencyStore,
};

const WEBHOOK_PATH = "/thechat/webhook";

type TheChatAccount = ReturnType<typeof resolveTheChatAccount>;
type DispatchedInboundOutcome = Extract<InboundOutcome, { kind: "dispatched" }>;

function collectHeaders(
  raw: Record<string, string | string[] | undefined> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      out[k] = v.join(",");
    } else if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

function formatLogMessage(
  message: string,
  fields?: Record<string, unknown>
): string {
  if (!fields || Object.keys(fields).length === 0) return message;
  try {
    return `${message} ${JSON.stringify(fields)}`;
  } catch {
    return message;
  }
}

function logPlugin(
  api: OpenClawPluginApi,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>
): void {
  const logger = api.logger as Record<string, unknown>;
  const fn = logger[level];
  if (typeof fn === "function") {
    fn.call(api.logger, formatLogMessage(message, fields));
  }
}

function getChannelRuntimeForInbound(api: OpenClawPluginApi): any | null {
  const runtime = (api as any).runtime?.channel;
  if (!runtime) return null;
  if (
    typeof runtime.routing?.resolveAgentRoute !== "function" ||
    typeof runtime.session?.resolveStorePath !== "function" ||
    typeof runtime.session?.readSessionUpdatedAt !== "function" ||
    typeof runtime.session?.recordInboundSession !== "function" ||
    typeof runtime.reply?.resolveEnvelopeFormatOptions !== "function" ||
    typeof runtime.reply?.formatAgentEnvelope !== "function" ||
    typeof runtime.reply?.finalizeInboundContext !== "function" ||
    typeof runtime.reply?.dispatchReplyWithBufferedBlockDispatcher !== "function"
  ) {
    return null;
  }
  return runtime;
}

async function dispatchInboundWithChannelRuntime({
  api,
  account,
  outcome,
}: {
  api: OpenClawPluginApi;
  account: TheChatAccount;
  outcome: DispatchedInboundOutcome;
}): Promise<boolean> {
  const channelRuntime = getChannelRuntimeForInbound(api);
  if (!channelRuntime) return false;

  const accountId = account.accountId ?? "default";
  const isDirect = outcome.mapping.chatType === "direct";
  const createdAtMs = Date.parse(outcome.payload.message.createdAt);
  const timestamp = Number.isFinite(createdAtMs) ? createdAtMs : Date.now();
  const conversationLabel = isDirect
    ? outcome.payload.message.senderName || `DM ${outcome.payload.conversation.id}`
    : outcome.payload.conversation.name ??
      `channel:${outcome.payload.conversation.id}`;
  const peer = {
    kind: isDirect ? ("direct" as const) : ("group" as const),
    id: isDirect
      ? outcome.payload.message.senderId
      : outcome.payload.conversation.id,
  };

  const startedAt = Date.now();
  logPlugin(api, "info", "thechat.inbound.channel_runtime_dispatch_start", {
    event: outcome.payload.event,
    accountId,
    chatType: outcome.mapping.chatType,
    sessionKey: outcome.mapping.sessionKey,
    target: outcome.mapping.to,
  });

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: api.config,
    channel: CHANNEL_ID,
    accountId,
    peer,
    runtime: channelRuntime,
    sessionStore: (api.config as any).session?.store,
  });
  const resolvedRoute = route as {
    accountId?: string;
    agentId: string;
    sessionKey: string;
  };
  const resolvedAccountId = resolvedRoute.accountId ?? accountId;

  const { storePath, body } = buildEnvelope({
    channel: "TheChat",
    from: conversationLabel,
    timestamp,
    body: outcome.payload.message.content,
  });

  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: outcome.payload.message.content,
    RawBody: outcome.payload.message.content,
    CommandBody: outcome.payload.message.content,
    From: `thechat:${outcome.payload.message.senderId}`,
    To: `thechat:${outcome.mapping.to}`,
    SessionKey: resolvedRoute.sessionKey,
    AccountId: resolvedAccountId,
    ChatType: outcome.mapping.chatType,
    ConversationLabel: conversationLabel,
    SenderName: outcome.payload.message.senderName || undefined,
    SenderId: outcome.payload.message.senderId,
    WasMentioned:
      outcome.payload.event === "mention" ? true : undefined,
    CommandAuthorized: true,
    Provider: "thechat",
    Surface: "thechat",
    MessageSid: outcome.payload.message.id,
    MessageSidFull: outcome.payload.message.id,
    Timestamp: timestamp,
    OriginatingChannel: "thechat",
    OriginatingTo: `thechat:${outcome.mapping.to}`,
  });

  await recordInboundSessionAndDispatchReply({
    cfg: api.config,
    channel: CHANNEL_ID,
    accountId: resolvedAccountId,
    agentId: resolvedRoute.agentId,
    routeSessionKey: resolvedRoute.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: channelRuntime.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
    deliver: async (payload) => {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) return;
      const deliverStartedAt = Date.now();
      logPlugin(api, "info", "thechat.outbound.reply_send_start", {
        target: outcome.mapping.to,
        textLength: text.length,
      });
      await sendText({
        config: account.config,
        to: outcome.mapping.to,
        text,
      });
      logPlugin(api, "info", "thechat.outbound.reply_send_done", {
        target: outcome.mapping.to,
        durationMs: Date.now() - deliverStartedAt,
      });
    },
    onRecordError: (error) => {
      logPlugin(api, "warn", "[thechat] failed to record inbound session", {
        error: String(error),
      });
    },
    onDispatchError: (error, info) => {
      logPlugin(api, "warn", "[thechat] failed to dispatch inbound reply", {
        error: String(error),
        kind: info.kind,
      });
    },
  });

  logPlugin(api, "info", "thechat.inbound.channel_runtime_dispatch_done", {
    event: outcome.payload.event,
    accountId: resolvedAccountId,
    chatType: outcome.mapping.chatType,
    sessionKey: resolvedRoute.sessionKey,
    durationMs: Date.now() - startedAt,
  });
  return true;
}

async function dispatchInboundOutcome({
  api,
  account,
  outcome,
}: {
  api: OpenClawPluginApi;
  account: TheChatAccount;
  outcome: DispatchedInboundOutcome;
}): Promise<void> {
  const dispatch =
    (api as any).dispatchInbound ??
    (api as any).runtime?.channel?.deliverInbound;
  if (typeof dispatch === "function") {
    const startedAt = Date.now();
    logPlugin(api, "info", "thechat.inbound.dispatch_runtime_start", {
      event: outcome.payload.event,
      sessionKey: outcome.mapping.sessionKey,
      target: outcome.mapping.to,
    });
    await dispatch({
      channel: CHANNEL_ID,
      accountId: account.accountId,
      target: outcome.mapping.to,
      sessionKey: outcome.mapping.sessionKey,
      chatType: outcome.mapping.chatType,
      message: {
        id: outcome.payload.message.id,
        text: outcome.payload.message.content,
        from: outcome.payload.message.senderId,
        fromName: outcome.payload.message.senderName,
        timestamp: outcome.payload.message.createdAt,
        wasMentioned: outcome.payload.event === "mention",
      },
    });
    logPlugin(api, "info", "thechat.inbound.dispatch_runtime_done", {
      event: outcome.payload.event,
      sessionKey: outcome.mapping.sessionKey,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const dispatchedWithRuntime = await dispatchInboundWithChannelRuntime({
    api,
    account,
    outcome,
  });
  if (dispatchedWithRuntime) {
    return;
  }

  api.logger?.warn?.(
    "[thechat] inbound dispatch helper not exposed by OpenClaw runtime; verified webhook ack'd but not routed to an agent"
  );
}

function runInboundDispatch(args: {
  api: OpenClawPluginApi;
  account: TheChatAccount;
  outcome: DispatchedInboundOutcome;
}): void {
  void dispatchInboundOutcome(args).catch((error) => {
    logPlugin(args.api, "warn", "[thechat] asynchronous inbound dispatch failed", {
      error: String(error),
    });
  });
}

function endAcceptedThenDispatch({
  res,
  dispatchArgs,
}: {
  res: any;
  dispatchArgs: {
    api: OpenClawPluginApi;
    account: TheChatAccount;
    outcome: DispatchedInboundOutcome;
  };
}): void {
  let started = false;
  const startDispatch = () => {
    if (started) return;
    started = true;
    setTimeout(() => runInboundDispatch(dispatchArgs), 0);
  };

  res.statusCode = 202;
  if (typeof res.once === "function") {
    res.once("finish", startDispatch);
  }
  try {
    res.end("accepted", startDispatch);
  } catch {
    res.end("accepted");
    startDispatch();
  }
}

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "TheChat",
  description:
    "OpenClaw channel plugin that connects to a TheChat workspace via signed webhooks (inbound) and the TheChat REST API (outbound).",
  plugin: theChatChannelPlugin,
  registerFull(api: OpenClawPluginApi) {
    // Phase 3: shared idempotency store — prevents duplicate dispatch across
    // webhook retries.  Scoped to the plugin lifetime; dispose() is called in
    // the unload hook if the runtime supports it.
    const idempotencyStore = createIdempotencyStore();
    const webhookRateLimiter = createFixedWindowRateLimiter({
      windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
      maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
      maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
    });
    const webhookInFlightLimiter = createWebhookInFlightLimiter({
      maxInFlightPerKey: WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey,
      maxTrackedKeys: WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys,
    });

    api.registerHttpRoute({
      path: WEBHOOK_PATH,
      auth: "plugin",
      match: "exact",
      async handler(req: any, res: any) {
        const requestKey = `${WEBHOOK_PATH}:${
          resolveRequestClientIp(req as IncomingMessage) ?? "unknown"
        }`;
        const pipeline = beginWebhookRequestPipelineOrReject({
          req: req as IncomingMessage,
          res: res as ServerResponse,
          allowMethods: ["POST"],
          requireJsonContentType: true,
          rateLimiter: webhookRateLimiter,
          rateLimitKey: requestKey,
          inFlightLimiter: webhookInFlightLimiter,
          inFlightKey: requestKey,
        });
        if (!pipeline.ok) {
          return true;
        }

        try {
          const bodyResult = await readWebhookBodyOrReject({
            req: req as IncomingMessage,
            res: res as ServerResponse,
            maxBytes: DEFAULT_WEBHOOK_MAX_BODY_BYTES,
            timeoutMs: WEBHOOK_BODY_READ_DEFAULTS.postAuth.timeoutMs,
            profile: "pre-auth",
            invalidBodyMessage: "invalid_body",
          });
          if (!bodyResult.ok) {
            return true;
          }
          const body = bodyResult.value;

          // Phase 3: try to identify the target account from the payload's
          // botId when multi-account is configured, falling back to the
          // default account for backward compat.
          let account: ReturnType<typeof resolveTheChatAccount>;
          try {
            const parsed = JSON.parse(body) as { bot?: { id?: string } };
            const botId = parsed?.bot?.id;
            if (botId) {
              const matched = findAccountByBotId(api.config, botId);
              account =
                matched ?? resolveTheChatAccount({ cfg: api.config, accountId: null });
            } else {
              account = resolveTheChatAccount({ cfg: api.config, accountId: null });
            }
          } catch {
            // JSON parse will fail again in handleInbound where it's properly
            // reported — just fall back to default account for now.
            account = resolveTheChatAccount({ cfg: api.config, accountId: null });
          }

          if (!account.enabled) {
            res.statusCode = 503;
            res.end("thechat channel disabled");
            return true;
          }
          if (!account.configured) {
            res.statusCode = 503;
            res.end("thechat channel not configured");
            return true;
          }

          const headers = collectHeaders(req.headers);
          const outcome = handleInbound({
            body,
            headers,
            config: account.config,
            idempotencyStore,
            log: (level, msg, fields) => {
              logPlugin(api, level, msg, fields);
            },
          });

          if (outcome.kind === "rejected") {
            res.statusCode = outcome.status;
            res.end(outcome.reason);
            return true;
          }
          if (outcome.kind === "skipped") {
            res.statusCode = 204;
            res.end();
            return true;
          }

          // A webhook ack must only mean "accepted for processing". Waiting for
          // the agent/LLM turn here keeps TheChat's delivery request open long
          // enough to hit its webhook timeout and abort the delivery.
          endAcceptedThenDispatch({
            res,
            dispatchArgs: { api, account, outcome },
          });
          return true;
        } finally {
          pipeline.release();
        }
      },
    });
  },
});
