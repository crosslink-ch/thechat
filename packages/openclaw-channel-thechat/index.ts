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
 * Inbound dispatch seam: `OpenClawPluginApi` exposes a stable
 * `registerHttpRoute` for hosting the webhook URL, but it does not yet expose
 * a stable, typed cross-channel `dispatchInbound` helper for non-bundled
 * channel plugins. We probe `api.dispatchInbound` and
 * `api.runtime.channel.deliverInbound` at runtime; if neither is present, the
 * webhook still verifies, maps, and ack's the request, and we surface a
 * structured warning. Once the SDK ships a stable inbound seam for non-bundled
 * channels (currently bundled gateway plugins own their own inbound loops),
 * this probe becomes the single line to swap.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { CHANNEL_ID, theChatChannelPlugin } from "./src/channel.js";
import { resolveTheChatAccount } from "./src/accounts.js";
import { handleInbound } from "./src/inbound.js";
import { sendText } from "./src/outbound.js";
import { deriveSessionMapping, parseTarget } from "./src/session.js";
import { shouldDispatch } from "./src/gating.js";
import { computeSignature, verifyWebhook } from "./src/signature.js";
import { validateConfig } from "./src/config-schema.js";
import {
  createApprovalRouter,
  formatApprovalMessage,
  matchApprovalResponse,
} from "./src/approvals.js";
import { runDoctorChecks } from "./src/doctor.js";
import type {
  TheChatChannelConfig,
  TheChatWebhookPayload,
} from "./src/types.js";
import type {
  ApprovalRouter,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalOutcome,
} from "./src/approvals.js";
import type { DoctorResult, DoctorCheck, CheckStatus } from "./src/doctor.js";

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
};

const WEBHOOK_PATH = "/thechat/webhook";

function readNodeRequestBody(req: {
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

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

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "TheChat",
  description:
    "OpenClaw channel plugin that connects to a TheChat workspace via signed webhooks (inbound) and the TheChat REST API (outbound).",
  plugin: theChatChannelPlugin,
  registerFull(api: OpenClawPluginApi) {
    api.registerHttpRoute({
      path: WEBHOOK_PATH,
      auth: "plugin",
      match: "exact",
      async handler(req: any, res: any) {
        let body: string;
        try {
          body = await readNodeRequestBody(req);
        } catch (err) {
          api.logger?.warn?.(
            `[thechat] failed to read webhook body: ${(err as Error).message}`
          );
          res.statusCode = 400;
          res.end("invalid_body");
          return true;
        }

        const account = resolveTheChatAccount({
          cfg: api.config,
          accountId: null,
        });
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
          log: (level, msg, fields) => {
            const log = api.logger?.[level];
            if (typeof log === "function") {
              log.call(api.logger, msg, fields);
            }
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

        // outcome.kind === "dispatched"
        const dispatch =
          (api as any).dispatchInbound ??
          (api as any).runtime?.channel?.deliverInbound;
        if (typeof dispatch === "function") {
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
        } else {
          api.logger?.warn?.(
            "[thechat] inbound dispatch helper not exposed by OpenClaw runtime; verified webhook ack'd but not routed to an agent"
          );
        }

        res.statusCode = 200;
        res.end("ok");
        return true;
      },
    });
  },
});
