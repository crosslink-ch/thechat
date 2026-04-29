import { describe, test, expect } from "bun:test";
import { validateConfig } from "./config-schema.js";

const minimal = {
  baseUrl: "https://chat.example",
  botId: "bot-1",
  botUserId: "user-bot-1",
  apiKey: "bot_x",
  webhookSecret: "whsec_y",
};

describe("validateConfig", () => {
  test("accepts a minimal config", () => {
    const r = validateConfig(minimal);
    expect(r.baseUrl).toBe(minimal.baseUrl);
    expect(r.botId).toBe(minimal.botId);
  });

  test("rejects null/undefined input", () => {
    expect(() => validateConfig(null)).toThrow(/object/);
    expect(() => validateConfig(undefined)).toThrow(/object/);
  });

  test("rejects when a required field is missing", () => {
    for (const drop of [
      "baseUrl",
      "botId",
      "botUserId",
      "apiKey",
      "webhookSecret",
    ]) {
      const broken = { ...minimal } as Record<string, unknown>;
      delete broken[drop];
      expect(() => validateConfig(broken)).toThrow(new RegExp(drop));
    }
  });

  test("rejects empty string for required fields", () => {
    expect(() => validateConfig({ ...minimal, apiKey: "" })).toThrow(/apiKey/);
  });

  test("rejects too-small maxClockSkewSeconds", () => {
    expect(() =>
      validateConfig({ ...minimal, maxClockSkewSeconds: 1 })
    ).toThrow(/maxClockSkewSeconds/);
  });

  test("rejects allowFrom that isn't an array", () => {
    expect(() =>
      validateConfig({ ...minimal, allowFrom: "user-1" } as any)
    ).toThrow(/allowFrom/);
  });

  test("preserves optional fields", () => {
    const r = validateConfig({
      ...minimal,
      maxClockSkewSeconds: 60,
      allowFrom: ["a"],
      requireMentionInChannels: false,
      allowOtherBots: true,
      botName: "MyBot",
    });
    expect(r.maxClockSkewSeconds).toBe(60);
    expect(r.allowFrom).toEqual(["a"]);
    expect(r.requireMentionInChannels).toBe(false);
    expect(r.allowOtherBots).toBe(true);
    expect(r.botName).toBe("MyBot");
  });
});
