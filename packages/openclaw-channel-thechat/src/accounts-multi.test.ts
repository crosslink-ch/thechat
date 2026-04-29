import { describe, test, expect } from "bun:test";
import {
  DEFAULT_ACCOUNT_ID,
  listTheChatAccountIds,
  resolveDefaultTheChatAccountId,
  resolveTheChatAccount,
  resolveAllTheChatAccounts,
  findAccountByBotId,
} from "./accounts.js";

const multiCfg = {
  channels: {
    thechat: {
      // Flat "default" account
      baseUrl: "https://default.chat.example.com",
      botId: "bot-default",
      botUserId: "user-bot-default",
      apiKey: "bot_default_key",
      webhookSecret: "whsec_default",
      botName: "DefaultBot",
      // Named accounts
      accounts: {
        staging: {
          baseUrl: "https://staging.chat.example.com",
          botId: "bot-staging",
          botUserId: "user-bot-staging",
          apiKey: "bot_staging_key",
          webhookSecret: "whsec_staging",
          botName: "StagingBot",
        },
        production: {
          baseUrl: "https://prod.chat.example.com",
          botId: "bot-prod",
          botUserId: "user-bot-prod",
          apiKey: "bot_prod_key",
          webhookSecret: "whsec_prod",
          botName: "ProdBot",
          allowFrom: ["user-1"],
          requireMentionInChannels: true,
        },
      },
    },
  },
};

const namedOnlyCfg = {
  channels: {
    thechat: {
      accounts: {
        alpha: {
          baseUrl: "https://alpha.example.com",
          botId: "bot-alpha",
          botUserId: "user-bot-alpha",
          apiKey: "bot_alpha_key",
          webhookSecret: "whsec_alpha",
        },
      },
    },
  },
};

describe("listTheChatAccountIds — multi-account", () => {
  test("lists default + named accounts", () => {
    const ids = listTheChatAccountIds(multiCfg);
    expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    expect(ids).toContain("staging");
    expect(ids).toContain("production");
    expect(ids).toHaveLength(3);
  });

  test("lists only named accounts when no flat config", () => {
    const ids = listTheChatAccountIds(namedOnlyCfg);
    expect(ids).toEqual(["alpha"]);
    expect(ids).not.toContain(DEFAULT_ACCOUNT_ID);
  });

  test("skips named accounts with no required fields", () => {
    const cfg = {
      channels: {
        thechat: {
          accounts: {
            empty: { botName: "Ghost" },
            valid: {
              baseUrl: "https://x",
              botId: "b",
              botUserId: "u",
              apiKey: "a",
              webhookSecret: "w",
            },
          },
        },
      },
    };
    const ids = listTheChatAccountIds(cfg);
    expect(ids).toEqual(["valid"]);
  });
});

describe("resolveDefaultTheChatAccountId — multi-account", () => {
  test("returns 'default' when flat config exists", () => {
    expect(resolveDefaultTheChatAccountId(multiCfg)).toBe(DEFAULT_ACCOUNT_ID);
  });

  test("falls back to first named account when no flat config", () => {
    expect(resolveDefaultTheChatAccountId(namedOnlyCfg)).toBe("alpha");
  });

  test("returns 'default' when nothing is configured", () => {
    expect(resolveDefaultTheChatAccountId({ channels: {} })).toBe(
      DEFAULT_ACCOUNT_ID
    );
  });
});

describe("resolveTheChatAccount — named accounts", () => {
  test("resolves a named account by id", () => {
    const account = resolveTheChatAccount({
      cfg: multiCfg,
      accountId: "staging",
    });
    expect(account.accountId).toBe("staging");
    expect(account.configured).toBe(true);
    expect(account.config.baseUrl).toBe("https://staging.chat.example.com");
    expect(account.config.botId).toBe("bot-staging");
    expect(account.name).toBe("StagingBot");
  });

  test("resolves production account with gating config", () => {
    const account = resolveTheChatAccount({
      cfg: multiCfg,
      accountId: "production",
    });
    expect(account.config.allowFrom).toEqual(["user-1"]);
    expect(account.config.requireMentionInChannels).toBe(true);
  });

  test("returns unconfigured when named account does not exist", () => {
    const account = resolveTheChatAccount({
      cfg: multiCfg,
      accountId: "nonexistent",
    });
    expect(account.accountId).toBe("nonexistent");
    expect(account.configured).toBe(false);
    expect(account.config.baseUrl).toBe("");
  });

  test("null accountId resolves to default (flat) account", () => {
    const account = resolveTheChatAccount({
      cfg: multiCfg,
      accountId: null,
    });
    expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(account.config.baseUrl).toBe("https://default.chat.example.com");
  });

  test("'default' accountId resolves to flat account", () => {
    const account = resolveTheChatAccount({
      cfg: multiCfg,
      accountId: "default",
    });
    expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(account.config.botId).toBe("bot-default");
  });
});

describe("resolveAllTheChatAccounts", () => {
  test("returns all accounts from multi config", () => {
    const all = resolveAllTheChatAccounts(multiCfg);
    expect(all).toHaveLength(3);
    const ids = all.map((a) => a.accountId);
    expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    expect(ids).toContain("staging");
    expect(ids).toContain("production");
  });

  test("returns empty array when nothing is configured", () => {
    const all = resolveAllTheChatAccounts({ channels: {} });
    expect(all).toEqual([]);
  });
});

describe("findAccountByBotId", () => {
  test("finds the correct account by botId", () => {
    const account = findAccountByBotId(multiCfg, "bot-staging");
    expect(account).not.toBeNull();
    expect(account!.accountId).toBe("staging");
  });

  test("finds the default account by botId", () => {
    const account = findAccountByBotId(multiCfg, "bot-default");
    expect(account).not.toBeNull();
    expect(account!.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  test("returns null when botId is not found", () => {
    expect(findAccountByBotId(multiCfg, "bot-nonexistent")).toBeNull();
  });

  test("returns null on empty config", () => {
    expect(findAccountByBotId({ channels: {} }, "bot-1")).toBeNull();
  });
});
