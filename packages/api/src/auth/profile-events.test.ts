import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { users, workspaceMembers, workspaces } from "../db/schema";
import {
  closeRealtimeBusForTests,
  LocalRealtimeBus,
  setRealtimeBusForTests,
  type RealtimeEvent,
} from "../realtime";
import { publishUserProfileUpdated } from "./profile-events";

const createdUserIds: string[] = [];

beforeEach(async () => {
  await setRealtimeBusForTests(new LocalRealtimeBus());
});

afterAll(async () => {
  await closeRealtimeBusForTests();
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("profile update realtime fanout", () => {
  test("notifies every member of each shared workspace", async () => {
    const updatedUserId = crypto.randomUUID();
    const teammateId = crypto.randomUUID();
    const workspaceId = `profile-${crypto.randomUUID()}`;
    createdUserIds.push(updatedUserId, teammateId);
    await db.insert(users).values([
      {
        id: updatedUserId,
        name: "Before Update",
        email: `profile-${updatedUserId}@test.com`,
        type: "human",
      },
      {
        id: teammateId,
        name: "Teammate",
        email: `profile-${teammateId}@test.com`,
        type: "human",
      },
    ]);
    await db.insert(workspaces).values({
      id: workspaceId,
      name: "Profile workspace",
      createdById: updatedUserId,
    });
    await db.insert(workspaceMembers).values([
      { workspaceId, userId: updatedUserId, role: "owner" },
      { workspaceId, userId: teammateId, role: "member" },
    ]);

    const events: RealtimeEvent[] = [];
    const bus = new LocalRealtimeBus();
    await setRealtimeBusForTests(bus);
    const unsubscribe = await bus.subscribe((event) => {
      events.push(event);
    });
    const avatar = "data:image/jpeg;base64,cHJvZmlsZQ==";

    await publishUserProfileUpdated({
      id: updatedUserId,
      name: "After Update",
      avatar,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.targetUserIds.toSorted()).toEqual(
      [updatedUserId, teammateId].toSorted(),
    );
    expect(events[0]).toMatchObject({
      type: "ws.event",
      event: {
        type: "member_updated",
        workspaceId,
        userId: updatedUserId,
        name: "After Update",
        avatar,
      },
    });
    await unsubscribe();
  });
});
