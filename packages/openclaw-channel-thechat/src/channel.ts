import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import {
  DEFAULT_ACCOUNT_ID,
  listTheChatAccountIds,
  resolveDefaultTheChatAccountId,
  resolveTheChatAccount,
  type ResolvedTheChatAccount,
} from "./accounts.js";
import { sendText } from "./outbound.js";
import { parseTarget } from "./session.js";

export const CHANNEL_ID = "thechat" as const;

interface ParseExplicitTargetParams {
  raw: string;
}

interface InferTargetChatTypeParams {
  to: string;
}

interface OutboundSendTextCtx {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
}

export const theChatChannelPlugin: ChannelPlugin<ResolvedTheChatAccount> =
  createChatChannelPlugin({
    base: {
      id: CHANNEL_ID,
      meta: {
        label: "TheChat",
      },
      capabilities: {
        chatTypes: ["direct", "group"],
      },
      reload: { configPrefixes: ["channels.thechat"] },
      config: {
        listAccountIds: (cfg: OpenClawConfig) => listTheChatAccountIds(cfg),
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
          resolveTheChatAccount({ cfg, accountId }),
        defaultAccountId: (cfg: OpenClawConfig) =>
          resolveDefaultTheChatAccountId(cfg),
        isConfigured: (account: ResolvedTheChatAccount) => account.configured,
        resolveAllowFrom: ({
          cfg,
          accountId,
        }: {
          cfg: OpenClawConfig;
          accountId?: string | null;
        }) => resolveTheChatAccount({ cfg, accountId }).config.allowFrom ?? [],
      },
      messaging: {
        normalizeTarget: (raw: string) => raw.trim(),
        parseExplicitTarget: ({ raw }: ParseExplicitTargetParams) => {
          const parsed = parseTarget(raw);
          if (!parsed) return { to: raw };
          return {
            to: `${parsed.kind}:${parsed.conversationId}`,
            chatType: parsed.kind === "dm" ? "direct" : "group",
          };
        },
        inferTargetChatType: ({ to }: InferTargetChatTypeParams) => {
          const parsed = parseTarget(to);
          if (!parsed) return undefined;
          return parsed.kind === "dm" ? "direct" : "group";
        },
        targetResolver: {
          looksLikeId: (raw: string) => /^(dm|channel):/i.test(raw.trim()),
          hint: "<dm:conversationId|channel:conversationId>",
        },
      },
    },
    outbound: {
      base: {
        deliveryMode: "direct",
      },
      attachedResults: {
        channel: CHANNEL_ID,
        sendText: async ({ cfg, to, text, accountId }: OutboundSendTextCtx) => {
          const account = resolveTheChatAccount({ cfg, accountId });
          if (!account.configured) {
            throw new Error(
              "thechat outbound: channel is not configured (cfg.channels.thechat is missing required fields)"
            );
          }
          const result = await sendText({
            config: account.config,
            to,
            text,
          });
          return { messageId: result.messageId };
        },
      },
    },
  });

export { DEFAULT_ACCOUNT_ID };
