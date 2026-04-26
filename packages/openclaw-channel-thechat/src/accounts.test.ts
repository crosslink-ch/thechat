import { describe, test, expect } from "bun:test";
import {
  DEFAULT_ACCOUNT_ID,
  listTheChatAccountIds,
  resolveDefaultTheChatAccountId,
  resolveTheChatAccount,
} from "./accounts.js";

const fullCfg = {
  channels: {
    thechat: {
      baseUrl: "https://chat.example.com",
      botId: "bot-1",
      botUserId: "user-bot-1",
      apiKey: "bot_xyz",
      webhookSecret: "whsec_x",
      botName: "OpenClaw",
      allowFrom: ["user-1"],
      requireMentionInChannels: false,
      allowOtherBots: true,
      maxClockSkewSeconds: 600,
    },
  },
};

describe("resolveTheChatAccount", () => {
  test("returns a configured account when all required fields are present", () => {
    const account = resolveTheChatAccount({ cfg: fullCfg, accountId: null });
    expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(true);
    expect(account.config.baseUrl).toBe("https://chat.example.com");
    expect(account.config.botName).toBe("OpenClaw");
    expect(account.config.allowFrom).toEqual(["user-1"]);
    expect(account.config.requireMentionInChannels).toBe(false);
    expect(account.config.allowOtherBots).toBe(true);
    expect(account.config.maxClockSkewSeconds).toBe(600);
  });

  test("flags an account as unconfigured when required fields are missing", () => {
    const account = resolveTheChatAccount({
      cfg: { channels: { thechat: { baseUrl: "https://x" } } },
      accountId: null,
    });
    expect(account.configured).toBe(false);
    expect(account.enabled).toBe(true);
  });

  test("respects channels.thechat.enabled = false", () => {
    const account = resolveTheChatAccount({
      cfg: {
        channels: { thechat: { ...fullCfg.channels.thechat, enabled: false } },
      },
      accountId: null,
    });
    expect(account.configured).toBe(true);
    expect(account.enabled).toBe(false);
  });

  test("returns an empty default config when no thechat section exists", () => {
    const account = resolveTheChatAccount({
      cfg: { channels: {} },
      accountId: null,
    });
    expect(account.configured).toBe(false);
    expect(account.config.baseUrl).toBe("");
    expect(account.config.apiKey).toBe("");
  });
});

describe("listTheChatAccountIds", () => {
  test("returns the default account when at least one required field is set", () => {
    expect(listTheChatAccountIds(fullCfg)).toEqual([DEFAULT_ACCOUNT_ID]);
  });

  test("returns no accounts when nothing is configured", () => {
    expect(listTheChatAccountIds({ channels: {} })).toEqual([]);
    expect(listTheChatAccountIds(undefined)).toEqual([]);
  });
});

describe("resolveDefaultTheChatAccountId", () => {
  test("always returns the default account id", () => {
    expect(resolveDefaultTheChatAccountId(fullCfg)).toBe(DEFAULT_ACCOUNT_ID);
    expect(resolveDefaultTheChatAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
  });
});
