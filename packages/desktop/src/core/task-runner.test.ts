import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Provider } from "@thechat/shared";
import type { ChatLoopOptions } from "./types";

// Mock dependencies before imports
vi.mock("./loop", () => ({
  runChatLoop: vi.fn(),
}));
vi.mock("../lib/effective-config", () => ({
  getEffectiveConfig: vi.fn(),
}));
vi.mock("../stores/codex-auth", () => ({
  useCodexAuthStore: {
    getState: () => ({
      getValidToken: vi.fn().mockResolvedValue({
        accessToken: "codex-token",
        accountId: "codex-account",
      }),
    }),
  },
}));

import { runChatLoop } from "./loop";
import { getEffectiveConfig } from "../lib/effective-config";
import { setTaskRunnerConfig, runTask } from "./task-runner";

const mockRunChatLoop = vi.mocked(runChatLoop);
const mockGetEffectiveConfig = vi.mocked(getEffectiveConfig);

/**
 * Expected provider configuration for sub-agents.
 *
 * `satisfies Record<Provider, ...>` ensures this object has an entry for every
 * variant of the Provider union. Adding a new provider to the shared type
 * without adding it here will cause a compile error.
 */
const PROVIDER_EXPECTATIONS = {
  openrouter: {
    provider: "openrouter",
    hasApiKey: true,
  },
  codex: {
    provider: "codex",
    hasCodexAuth: true,
  },
  glm: {
    provider: "glm",
    hasGlmApiKey: true,
    hasGlmPlanType: true,
  },
  featherless: {
    provider: "featherless",
    hasFeatherlessApiKey: true,
  },
  azulai: {
    provider: "azulai",
    hasAzulaiApiUrl: true,
    hasAzulaiApiKey: true,
  },
} satisfies Record<Provider, { provider: string; [k: string]: unknown }>;

function makeAppConfig(provider: Provider) {
  return {
    config: {
      api_key: "or-key",
      glm_api_key: "glm-key",
      glmPlanType: "coding" as const,
      featherless_api_key: "fl-key",
      azulai_api_url: "https://api.azulai.example.com",
      azulai_api_key: "az-key",
      provider,
      providers: {
        openrouter: { model: "openrouter-model" },
        codex: { model: "codex-model" },
        glm: { model: "glm-model" },
        featherless: { model: "featherless-model" },
        azulai: { model: "azulai-model" },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setTaskRunnerConfig({
    availableTools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ],
    cwd: "/test",
  });
  mockRunChatLoop.mockResolvedValue(undefined);
});

describe("runTask provider passthrough", () => {
  it("passes provider='openrouter' when config says openrouter", async () => {
    mockGetEffectiveConfig.mockResolvedValue(makeAppConfig("openrouter"));

    await runTask("do something");

    const opts = mockRunChatLoop.mock.calls[0][0] as ChatLoopOptions;
    expect(opts.provider).toBe("openrouter");
    expect(opts.apiKey).toBe("or-key");
  });

  it("passes provider='codex' with codexAuth when config says codex", async () => {
    mockGetEffectiveConfig.mockResolvedValue(makeAppConfig("codex"));

    await runTask("do something");

    const opts = mockRunChatLoop.mock.calls[0][0] as ChatLoopOptions;
    expect(opts.provider).toBe("codex");
    expect(opts.codexAuth).toEqual({
      accessToken: "codex-token",
      accountId: "codex-account",
    });
  });

  it("passes provider='glm' with glmApiKey and glmPlanType when config says glm", async () => {
    mockGetEffectiveConfig.mockResolvedValue(makeAppConfig("glm"));

    await runTask("do something");

    const opts = mockRunChatLoop.mock.calls[0][0] as ChatLoopOptions;
    expect(opts.provider).toBe("glm");
    expect(opts.glmApiKey).toBe("glm-key");
    expect(opts.glmPlanType).toBe("coding");
  });

  // Exhaustive: every provider listed in PROVIDER_EXPECTATIONS must be tested.
  // If a new provider is added to the Provider union, PROVIDER_EXPECTATIONS will
  // require a new entry (compile error), and this loop will fail at runtime until
  // a matching test case passes.
  it.each(Object.keys(PROVIDER_EXPECTATIONS))(
    "correctly routes provider '%s' to runChatLoop",
    async (provider) => {
      mockGetEffectiveConfig.mockResolvedValue(makeAppConfig(provider as Provider));

      await runTask("do something");

      expect(mockRunChatLoop).toHaveBeenCalledTimes(1);
      const opts = mockRunChatLoop.mock.calls[0][0] as ChatLoopOptions;

      const expected = PROVIDER_EXPECTATIONS[provider as Provider];
      expect(opts.provider).toBe(expected.provider);

      if ("hasCodexAuth" in expected) {
        expect(opts.codexAuth).toBeDefined();
      }
      if ("hasGlmApiKey" in expected) {
        expect(opts.glmApiKey).toBeDefined();
      }
      if ("hasGlmPlanType" in expected) {
        expect(opts.glmPlanType).toBeDefined();
      }
      if ("hasFeatherlessApiKey" in expected) {
        expect(opts.featherlessApiKey).toBeDefined();
      }
      if ("hasAzulaiApiUrl" in expected) {
        expect(opts.azulaiApiUrl).toBeDefined();
      }
      if ("hasAzulaiApiKey" in expected) {
        expect(opts.azulaiApiKey).toBeDefined();
      }
    },
  );
});
