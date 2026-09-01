import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  botInvocations,
  bots,
  conversations,
  messages,
  users,
} from "../db/schema";
import { pruneTerminalBotInvocations } from "./cleanup";

let ownerId = "";
let botUserId = "";
let botId = "";
let conversationId = "";

beforeAll(async () => {
  const [owner] = await db
    .insert(users)
    .values({
      name: "Invocation cleanup owner",
      email: `invocation-cleanup-${crypto.randomUUID()}@test.com`,
    })
    .returning({ id: users.id });
  const [botUser] = await db
    .insert(users)
    .values({ name: "Invocation cleanup bot", type: "bot" })
    .returning({ id: users.id });
  const [conversation] = await db
    .insert(conversations)
    .values({ type: "direct", title: "Invocation cleanup test" })
    .returning({ id: conversations.id });
  const [bot] = await db
    .insert(bots)
    .values({
      userId: botUser.id,
      ownerId: owner.id,
      kind: "hermes",
      webhookSecret: crypto.randomUUID(),
    })
    .returning({ id: bots.id });

  ownerId = owner.id;
  botUserId = botUser.id;
  botId = bot.id;
  conversationId = conversation.id;
});

afterAll(async () => {
  if (conversationId) {
    await db
      .delete(conversations)
      .where(inArray(conversations.id, [conversationId]));
  }
  const userIds = [ownerId, botUserId].filter(Boolean);
  if (userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, userIds));
  }
});

describe("bot invocation retention", () => {
  test("deletes only terminal rows before the cutoff", async () => {
    const [responseMessage] = await db
      .insert(messages)
      .values({
        conversationId,
        senderId: botUserId,
        clientMessageId: crypto.randomUUID(),
        content: "Durable final bot response",
      })
      .returning({ id: messages.id });
    const oldClaimed = await createInvocation({
      status: "claimed",
      completedAt: new Date("2019-01-01T00:00:00.000Z"),
      updatedAt: new Date("2019-01-01T00:00:00.000Z"),
      responseJson: { completion: { type: "message" } },
      responseMessageId: responseMessage.id,
    });
    const oldFailed = await createInvocation({
      status: "failed",
      completedAt: new Date("2019-02-01T00:00:00.000Z"),
      updatedAt: new Date("2019-02-01T00:00:00.000Z"),
    });
    const recentCompleted = await createInvocation({
      status: "claimed",
      completedAt: new Date("2018-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      responseJson: { completion: { type: "message" } },
    });
    const incomplete = await createInvocation({
      status: "claimed",
      createdAt: new Date("2018-01-01T00:00:00.000Z"),
      updatedAt: new Date("2018-01-01T00:00:00.000Z"),
    });
    const deliveredButActive = await createInvocation({
      status: "claimed",
      completedAt: new Date("2018-01-01T00:00:00.000Z"),
      updatedAt: new Date("2018-01-01T00:00:00.000Z"),
    });

    expect(
      await pruneTerminalBotInvocations({
        before: new Date("2020-01-01T00:00:00.000Z"),
        batchSize: 10,
      }),
    ).toBe(2);

    const remaining = await db
      .select({ id: botInvocations.id })
      .from(botInvocations)
      .where(
        inArray(botInvocations.id, [
          oldClaimed,
          oldFailed,
          recentCompleted,
          incomplete,
          deliveredButActive,
        ]),
      );
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [recentCompleted, incomplete, deliveredButActive].sort(),
    );
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.id, responseMessage.id)),
    ).toEqual([{ id: responseMessage.id }]);
  });

  test("deletes at most one configured batch", async () => {
    const ids = await Promise.all([
      createInvocation({
        status: "claimed",
        completedAt: new Date("2018-01-01T00:00:00.000Z"),
        updatedAt: new Date("2018-01-01T00:00:00.000Z"),
        responseJson: { completion: { type: "message" } },
      }),
      createInvocation({
        status: "failed",
        completedAt: new Date("2018-02-01T00:00:00.000Z"),
        updatedAt: new Date("2018-02-01T00:00:00.000Z"),
      }),
      createInvocation({
        status: "claimed",
        completedAt: new Date("2018-03-01T00:00:00.000Z"),
        updatedAt: new Date("2018-03-01T00:00:00.000Z"),
        responseJson: { silent: true },
      }),
    ]);

    expect(
      await pruneTerminalBotInvocations({
        before: new Date("2020-01-01T00:00:00.000Z"),
        batchSize: 2,
      }),
    ).toBe(2);

    const remaining = await db
      .select({ id: botInvocations.id })
      .from(botInvocations)
      .where(inArray(botInvocations.id, ids));
    expect(remaining).toHaveLength(1);
  });

  test("has a partial index for terminal retention scans", async () => {
    const rows = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'bot_invocations'
        AND indexname = 'bot_invocations_terminal_retention_idx'
    `);
    const indexes = Array.from(rows);

    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain("(updated_at, id)");
    expect(indexes[0]?.indexdef).toContain("completed_at IS NOT NULL");
    expect(indexes[0]?.indexdef).toContain("status");
    expect(indexes[0]?.indexdef).toContain("completion");
    expect(indexes[0]?.indexdef).toContain("silent");
  });
});

async function createInvocation(input: {
  status: string;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  responseJson?: Record<string, unknown>;
  responseMessageId?: string;
}) {
  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      senderId: ownerId,
      clientMessageId: crypto.randomUUID(),
      content: "Trigger cleanup fixture",
    })
    .returning({ id: messages.id });
  const [invocation] = await db
    .insert(botInvocations)
    .values({
      botId,
      conversationId,
      triggerMessageId: message.id,
      adapterKind: "hermes",
      status: input.status,
      completedAt: input.completedAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt ?? input.createdAt,
      responseJson: input.responseJson,
      responseMessageId: input.responseMessageId,
    })
    .returning({ id: botInvocations.id });
  return invocation.id;
}
