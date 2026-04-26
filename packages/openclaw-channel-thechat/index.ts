/**
 * OpenClaw entry point for the TheChat channel plugin.
 *
 * The wiring here is intentionally thin: heavy lifting lives in the pure
 * helpers under `./src/*` so the same logic can be unit-tested without
 * pulling in OpenClaw's runtime, and reused from a custom HTTP layer if an
 * operator wants to host the webhook receiver themselves.
 *
 * Remaining seam (see README): a full bundled `createChatChannelPlugin(...)`
 * adapter is sketched below but kept generic — the package is published
 * standalone, so it doesn't import from `@openclaw/plugin-sdk` workspace
 * paths. Operators building this plugin in-tree against a specific
 * OpenClaw version should swap the dynamic import for a direct import of
 * `openclaw/plugin-sdk/channel-core` and tighten the channel surface
 * (gateway start, outbound delegate, setup wizard) to match their version.
 */

import { handleInbound } from "./src/inbound.js";
import { sendText } from "./src/outbound.js";
import { deriveSessionMapping, parseTarget } from "./src/session.js";
import { shouldDispatch } from "./src/gating.js";
import { computeSignature, verifyWebhook } from "./src/signature.js";
import { validateConfig } from "./src/config-schema.js";
import type {
  TheChatChannelConfig,
  TheChatWebhookPayload,
} from "./src/types.js";

export const CHANNEL_ID = "thechat" as const;

export {
  handleInbound,
  sendText,
  deriveSessionMapping,
  parseTarget,
  shouldDispatch,
  computeSignature,
  verifyWebhook,
  validateConfig,
};
export type { TheChatChannelConfig, TheChatWebhookPayload };

/**
 * Default export: a description of the plugin that an OpenClaw runtime can
 * register. We avoid hard-importing `openclaw/plugin-sdk/channel-core` at
 * module load time so the package can be loaded by the TheChat monorepo
 * (which doesn't ship OpenClaw) for testing the helpers.
 *
 * When loaded inside an OpenClaw runtime, the operator's bootstrap should
 * call `installTheChatChannel(api)` (below) which performs the dynamic
 * import and wiring against the SDK shape they actually have installed.
 */
export interface InstallTheChatChannelDeps {
  /** Plugin runtime registration API exposed by `defineChannelPluginEntry`. */
  api: any;
  /** Resolved channel config — typically from `cfg.channels.thechat`. */
  config: TheChatChannelConfig;
  /** Optional logger; defaults to console. */
  log?: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;
}

export async function installTheChatChannel(
  deps: InstallTheChatChannelDeps
): Promise<void> {
  const { api, config, log } = deps;

  // Webhook receiver — verifies HMAC, enforces gating, hands the dispatch
  // back to OpenClaw's inbound queue.
  api.registerHttpRoute({
    path: "/thechat/webhook",
    auth: "plugin",
    handler: async (req: any, res: any) => {
      const body = await req.text();
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers.entries?.() ?? []) headers[k] = v;

      const outcome = handleInbound({ body, headers, config, log });

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

      // Hand the verified message to OpenClaw. The exact dispatch helper
      // varies by SDK version — typical names: `api.dispatchInbound(...)`
      // or `api.runtime.channel.deliverInbound(...)`. Fall back to a
      // best-effort shape so this stays compile-safe.
      const dispatch =
        api.dispatchInbound ?? api.runtime?.channel?.deliverInbound;
      if (typeof dispatch === "function") {
        await dispatch({
          channel: CHANNEL_ID,
          accountId: config.botId,
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
        log?.("warn", "thechat.entry.no_dispatch_helper");
      }

      res.statusCode = 200;
      res.end("ok");
      return true;
    },
  });

  // Outbound — register a send delegate keyed on the `thechat:` target.
  if (typeof api.registerOutboundSend === "function") {
    api.registerOutboundSend({
      channel: CHANNEL_ID,
      sendText: ({ to, text }: { to: string; text: string }) =>
        sendText({ config, to, text }),
    });
  }
}

/**
 * For OpenClaw versions that prefer a single default-export plugin shape,
 * we expose a minimal descriptor. Wiring it through
 * `defineChannelPluginEntry` is left to the consumer because the SDK shape
 * has churned across betas.
 */
export default {
  id: CHANNEL_ID,
  install: installTheChatChannel,
  validateConfig,
};
