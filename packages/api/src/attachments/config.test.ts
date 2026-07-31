import { describe, expect, test } from "bun:test";
import { loadAttachmentConfig } from "./config";

const MIB = 1024 * 1024;

describe("attachment config", () => {
  test("uses one shared set of attachment defaults for every actor", () => {
    const config = loadAttachmentConfig({} as NodeJS.ProcessEnv);

    expect(config.maxBytes).toBe(25 * MIB);
    expect(config.maxPerMessage).toBe(10);
    expect(config.draftQuotaBytes).toBe(500 * MIB);
    expect("botMaxBytes" in config).toBe(false);
    expect("botMaxPerMessage" in config).toBe(false);
    expect("botDraftQuotaBytes" in config).toBe(false);
    expect(config.uploadTtlSeconds).toBe(300);
    expect(config.downloadTtlSeconds).toBe(90);
    expect(config.unattachedTtlSeconds).toBe(30 * 24 * 60 * 60);
  });

  test("ignores legacy bot-specific overrides in favor of shared limits", () => {
    const config = loadAttachmentConfig({
      ATTACHMENT_MAX_BYTES: String(2 * MIB),
      ATTACHMENT_MAX_PER_MESSAGE: "3",
      ATTACHMENT_DRAFT_QUOTA_BYTES: String(8 * MIB),
      ATTACHMENT_BOT_MAX_BYTES: String(1 * MIB),
      ATTACHMENT_BOT_MAX_PER_MESSAGE: "1",
      ATTACHMENT_BOT_DRAFT_QUOTA_BYTES: String(1 * MIB),
    } as NodeJS.ProcessEnv);

    expect(config.maxBytes).toBe(2 * MIB);
    expect(config.maxPerMessage).toBe(3);
    expect(config.draftQuotaBytes).toBe(8 * MIB);
    expect("botMaxBytes" in config).toBe(false);
    expect("botMaxPerMessage" in config).toBe(false);
    expect("botDraftQuotaBytes" in config).toBe(false);
  });
});
