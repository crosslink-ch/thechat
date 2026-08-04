import { describe, expect, test } from "bun:test";
import { hermesBotUpdateSchema } from "./index";
import { stripBotMention } from "../services/hermes";

describe("Hermes bot helpers", () => {
  test("strips a Hermes mention without regex surprises", () => {
    expect(stripBotMention("@Koda.bot   summarize this", "Koda.bot")).toBe("summarize this");
  });

  test("rejects the removed default instructions setting", () => {
    const result = hermesBotUpdateSchema.safeParse({
      defaultInstructions: "Reply concisely in TheChat.",
    });

    expect(result.success).toBe(false);
  });

  test("still accepts the supported default mode setting", () => {
    expect(hermesBotUpdateSchema.safeParse({ defaultMode: "run" }).success).toBe(true);
  });
});
