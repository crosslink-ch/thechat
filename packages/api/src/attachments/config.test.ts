import { describe, expect, test } from "bun:test";
import { loadAttachmentConfig } from "./config";

const MIB = 1024 * 1024;

describe("attachment config", () => {
  test("uses conservative human and bot defaults", () => {
    const config = loadAttachmentConfig({} as NodeJS.ProcessEnv);

    expect(config.maxBytes).toBe(25 * MIB);
    expect(config.maxPerMessage).toBe(10);
    expect(config.draftQuotaBytes).toBe(500 * MIB);
    expect(config.botMaxBytes).toBe(10 * MIB);
    expect(config.botMaxPerMessage).toBe(5);
    expect(config.botDraftQuotaBytes).toBe(50 * MIB);
    expect(config.uploadTtlSeconds).toBe(300);
    expect(config.downloadTtlSeconds).toBe(90);
    expect(config.unattachedTtlSeconds).toBe(30 * 24 * 60 * 60);
  });

  test("never allows bot limits to exceed the configured human limits", () => {
    const config = loadAttachmentConfig({
      ATTACHMENT_MAX_BYTES: String(2 * MIB),
      ATTACHMENT_MAX_PER_MESSAGE: "3",
      ATTACHMENT_DRAFT_QUOTA_BYTES: String(8 * MIB),
      ATTACHMENT_BOT_MAX_BYTES: String(50 * MIB),
      ATTACHMENT_BOT_MAX_PER_MESSAGE: "25",
      ATTACHMENT_BOT_DRAFT_QUOTA_BYTES: String(500 * MIB),
    } as NodeJS.ProcessEnv);

    expect(config.maxBytes).toBe(2 * MIB);
    expect(config.maxPerMessage).toBe(3);
    expect(config.draftQuotaBytes).toBe(8 * MIB);
    expect(config.botMaxBytes).toBe(2 * MIB);
    expect(config.botMaxPerMessage).toBe(3);
    expect(config.botDraftQuotaBytes).toBe(8 * MIB);
  });
});
