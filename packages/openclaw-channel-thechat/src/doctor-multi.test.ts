import { describe, test, expect } from "bun:test";
import { runDoctorChecks, runMultiAccountDoctorChecks } from "./doctor.js";
import type { TheChatChannelConfig } from "./types.js";

const validConfig: TheChatChannelConfig = {
  baseUrl: "https://chat.example.com",
  botId: "bot-1",
  botUserId: "user-bot-1",
  apiKey: "bot_longapikey123456",
  webhookSecret: "whsec_longsecretvalue1234567890",
};

const okFetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "",
})) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Phase 3: webhook_secret_strength check
// ---------------------------------------------------------------------------

describe("runDoctorChecks — webhook_secret_strength", () => {
  test("passes when secret is long enough", async () => {
    const result = await runDoctorChecks(validConfig, { fetchImpl: okFetch });
    const check = result.checks.find((c) => c.name === "webhook_secret_strength");
    expect(check).toBeDefined();
    expect(check!.status).toBe("pass");
  });

  test("warns when secret is too short", async () => {
    const config = { ...validConfig, webhookSecret: "whsec_short" };
    const result = await runDoctorChecks(config, { fetchImpl: okFetch });
    const check = result.checks.find((c) => c.name === "webhook_secret_strength");
    expect(check).toBeDefined();
    expect(check!.status).toBe("warn");
    expect(check!.message).toContain("only 5 characters");
  });

  test("warns when short secret without prefix", async () => {
    const config = { ...validConfig, webhookSecret: "abc" };
    const result = await runDoctorChecks(config, { fetchImpl: okFetch });
    const check = result.checks.find((c) => c.name === "webhook_secret_strength");
    expect(check!.status).toBe("warn");
  });

  test("skips when secret is empty", async () => {
    // Won't reach this check since required_fields will fail, but let's test
    // the function directly
    const config = { ...validConfig, webhookSecret: "" };
    const result = await runDoctorChecks(config, { fetchImpl: okFetch });
    // required_fields fails → network checks skip
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: multi-account doctor
// ---------------------------------------------------------------------------

describe("runMultiAccountDoctorChecks", () => {
  const multiCfg = {
    channels: {
      thechat: {
        baseUrl: "https://default.chat.example.com",
        botId: "bot-default",
        botUserId: "user-bot-default",
        apiKey: "bot_defaultkey1234567890",
        webhookSecret: "whsec_defaultsecret1234567890",
        accounts: {
          staging: {
            baseUrl: "https://staging.chat.example.com",
            botId: "bot-staging",
            botUserId: "user-bot-staging",
            apiKey: "bot_stagingkey1234567890",
            webhookSecret: "whsec_stagingsecret1234567890",
          },
        },
      },
    },
  };

  test("returns per-account results plus cross-account checks", async () => {
    const result = await runMultiAccountDoctorChecks(multiCfg, {
      fetchImpl: okFetch,
    });
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0].accountId).toBe("default");
    expect(result.accounts[1].accountId).toBe("staging");
    expect(result.crossAccountChecks.length).toBeGreaterThan(0);
  });

  test("passes when all accounts are valid and unique", async () => {
    const result = await runMultiAccountDoctorChecks(multiCfg, {
      fetchImpl: okFetch,
    });
    expect(result.ok).toBe(true);
    const uniqueBots = result.crossAccountChecks.find(
      (c) => c.name === "cross_account_unique_bot_ids"
    );
    expect(uniqueBots?.status).toBe("pass");
  });

  test("fails when botIds are duplicated across accounts", async () => {
    const dupeCfg = {
      channels: {
        thechat: {
          baseUrl: "https://a.example.com",
          botId: "bot-same",
          botUserId: "u1",
          apiKey: "bot_aaaaaaaaaaaaaaaa",
          webhookSecret: "whsec_aaaaaaaaaaaaaaaa",
          accounts: {
            other: {
              baseUrl: "https://b.example.com",
              botId: "bot-same", // duplicate!
              botUserId: "u2",
              apiKey: "bot_bbbbbbbbbbbbbbbb",
              webhookSecret: "whsec_bbbbbbbbbbbbbbbb",
            },
          },
        },
      },
    };
    const result = await runMultiAccountDoctorChecks(dupeCfg, {
      fetchImpl: okFetch,
    });
    expect(result.ok).toBe(false);
    const uniqueBots = result.crossAccountChecks.find(
      (c) => c.name === "cross_account_unique_bot_ids"
    );
    expect(uniqueBots?.status).toBe("fail");
    expect(uniqueBots?.message).toContain("bot-same");
  });

  test("warns when webhook secrets are shared across accounts", async () => {
    const sharedSecretCfg = {
      channels: {
        thechat: {
          baseUrl: "https://a.example.com",
          botId: "bot-a",
          botUserId: "u1",
          apiKey: "bot_aaaaaaaaaaaaaaaa",
          webhookSecret: "whsec_shared_secret_1234567",
          accounts: {
            other: {
              baseUrl: "https://b.example.com",
              botId: "bot-b",
              botUserId: "u2",
              apiKey: "bot_bbbbbbbbbbbbbbbb",
              webhookSecret: "whsec_shared_secret_1234567", // same!
            },
          },
        },
      },
    };
    const result = await runMultiAccountDoctorChecks(sharedSecretCfg, {
      fetchImpl: okFetch,
    });
    const uniqueSecrets = result.crossAccountChecks.find(
      (c) => c.name === "cross_account_unique_secrets"
    );
    expect(uniqueSecrets?.status).toBe("warn");
  });

  test("warns when no accounts are configured", async () => {
    const result = await runMultiAccountDoctorChecks(
      { channels: {} },
      { fetchImpl: okFetch }
    );
    expect(result.accounts).toHaveLength(0);
    const countCheck = result.crossAccountChecks.find(
      (c) => c.name === "cross_account_count"
    );
    expect(countCheck?.status).toBe("warn");
  });

  test("handles named-only config (no flat default)", async () => {
    const namedOnly = {
      channels: {
        thechat: {
          accounts: {
            prod: {
              baseUrl: "https://prod.example.com",
              botId: "bot-prod",
              botUserId: "user-prod",
              apiKey: "bot_prodkey1234567890",
              webhookSecret: "whsec_prodsecret1234567890",
            },
          },
        },
      },
    };
    const result = await runMultiAccountDoctorChecks(namedOnly, {
      fetchImpl: okFetch,
    });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].accountId).toBe("prod");
    expect(result.ok).toBe(true);
  });
});
