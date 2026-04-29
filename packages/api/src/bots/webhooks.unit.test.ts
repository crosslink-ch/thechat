/**
 * Unit tests for the pure helpers exported by ./webhooks. These don't touch
 * the database, network, or the Elysia app — they assert the dispatch
 * decision logic and the @-mention regex behave as expected.
 */
import { describe, test, expect } from "bun:test";
import {
  isMentioned,
  selectDispatchTargets,
  signWebhookPayload,
} from "./webhooks-core";

const aliceMsg = {
  id: "m1",
  conversationId: "c1",
  senderId: "user-alice",
  senderName: "Alice",
  senderType: "human" as const,
  content: "",
  createdAt: new Date().toISOString(),
};

const botFoo = {
  botId: "bot-foo",
  botUserId: "user-bot-foo",
  webhookUrl: "https://hook.example/foo",
  webhookSecret: "whsec_foo",
  botName: "Foo",
};

const botBar = {
  botId: "bot-bar",
  botUserId: "user-bot-bar",
  webhookUrl: "https://hook.example/bar",
  webhookSecret: "whsec_bar",
  botName: "Bar",
};

describe("isMentioned", () => {
  test("matches @Bot at the start", () => {
    expect(isMentioned("@Foo hello", "Foo")).toBe(true);
  });

  test("matches @Bot in the middle", () => {
    expect(isMentioned("hey @Foo can you", "Foo")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isMentioned("@FOO is here", "Foo")).toBe(true);
  });

  test("does not match a partial name (@FooBar should not match @Foo)", () => {
    expect(isMentioned("hi @FooBar", "Foo")).toBe(false);
  });

  test("does not match plain text containing the bot name", () => {
    expect(isMentioned("Foo is the name", "Foo")).toBe(false);
  });

  test("does not false-match without the @ prefix", () => {
    expect(isMentioned("see Foo's reply", "Foo")).toBe(false);
  });

  test("escapes regex metachars in the bot name", () => {
    expect(isMentioned("@a.b reply", "a.b")).toBe(true);
    // Should NOT match across an unrelated dot character.
    expect(isMentioned("@axb reply", "a.b")).toBe(false);
  });
});

describe("selectDispatchTargets", () => {
  test("DM: every recipient bot fires direct_message", () => {
    const targets = selectDispatchTargets({
      message: aliceMsg,
      conversationType: "direct",
      participantBots: [botFoo],
    });
    expect(targets).toEqual([{ bot: botFoo, event: "direct_message" }]);
  });

  test("channel: only @mentioned bots fire", () => {
    const targets = selectDispatchTargets({
      message: { ...aliceMsg, content: "hey @Bar" },
      conversationType: "group",
      participantBots: [botFoo, botBar],
    });
    expect(targets).toEqual([{ bot: botBar, event: "mention" }]);
  });

  test("channel: nobody fires when no one is mentioned", () => {
    expect(
      selectDispatchTargets({
        message: { ...aliceMsg, content: "hi all" },
        conversationType: "group",
        participantBots: [botFoo, botBar],
      })
    ).toEqual([]);
  });

  test("loop prevention: bot's own message yields no target", () => {
    const fromFoo = {
      ...aliceMsg,
      senderId: botFoo.botUserId,
      senderType: "bot" as const,
      content: "hey @Bar",
    };
    expect(
      selectDispatchTargets({
        message: fromFoo,
        conversationType: "group",
        participantBots: [botFoo, botBar],
      })
    ).toEqual([]);
  });

  test("loop prevention: cross-bot mentions are dropped by default", () => {
    const fromBar = {
      ...aliceMsg,
      senderId: botBar.botUserId,
      senderType: "bot" as const,
      content: "ping @Foo",
    };
    expect(
      selectDispatchTargets({
        message: fromBar,
        conversationType: "group",
        participantBots: [botFoo, botBar],
      })
    ).toEqual([]);
  });

  test("multiple mentions: each mentioned bot gets its own dispatch", () => {
    const targets = selectDispatchTargets({
      message: { ...aliceMsg, content: "hi @Foo and @Bar" },
      conversationType: "group",
      participantBots: [botFoo, botBar],
    });
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.bot.botId).sort()).toEqual(["bot-bar", "bot-foo"]);
    for (const t of targets) expect(t.event).toBe("mention");
  });
});

describe("signWebhookPayload", () => {
  test("identical inputs produce identical signatures", () => {
    const a = signWebhookPayload("body", "secret", 1700);
    const b = signWebhookPayload("body", "secret", 1700);
    expect(a).toBe(b);
  });

  test("different timestamp changes the signature", () => {
    expect(signWebhookPayload("body", "secret", 1700)).not.toBe(
      signWebhookPayload("body", "secret", 1701)
    );
  });

  test("different body changes the signature", () => {
    expect(signWebhookPayload("a", "secret", 1700)).not.toBe(
      signWebhookPayload("b", "secret", 1700)
    );
  });
});
