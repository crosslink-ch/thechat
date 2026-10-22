import { eq } from "drizzle-orm";
import type { NotificationPreferences } from "@thechat/shared";
import { db } from "../db";
import { notificationPreferences } from "../db/schema";

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  directMessages: true,
  mentions: true,
  agentReplies: true,
  agentRequests: true,
  showPreviews: true,
};

type Executor = Pick<typeof db, "select">;

export async function getNotificationPreferences(
  userId: string,
  executor: Executor = db,
): Promise<NotificationPreferences> {
  const [row] = await executor
    .select({
      directMessages: notificationPreferences.directMessages,
      mentions: notificationPreferences.mentions,
      agentReplies: notificationPreferences.agentReplies,
      agentRequests: notificationPreferences.agentRequests,
      showPreviews: notificationPreferences.showPreviews,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);
  return row ?? { ...DEFAULT_NOTIFICATION_PREFERENCES };
}

export async function updateNotificationPreferences(
  userId: string,
  changes: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const current = await getNotificationPreferences(userId);
  const next = { ...current, ...changes };
  await db
    .insert(notificationPreferences)
    .values({ userId, ...next })
    .onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: { ...changes, updatedAt: new Date() },
    });
  return getNotificationPreferences(userId);
}
