import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { workspaceMembers } from "../db/schema";
import { publishWsEventToUsers } from "../realtime";

interface UpdatedProfile {
  id: string;
  name: string;
  avatar: string | null;
}

export async function publishUserProfileUpdated(profile: UpdatedProfile) {
  const membershipRows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, profile.id));
  const workspaceIds = [...new Set(membershipRows.map((row) => row.workspaceId))];
  if (workspaceIds.length === 0) return;

  const recipientRows = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
    })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.workspaceId, workspaceIds));

  await Promise.all(
    workspaceIds.map((workspaceId) =>
      publishWsEventToUsers(
        recipientRows
          .filter((recipient) => recipient.workspaceId === workspaceId)
          .map((recipient) => recipient.userId),
        {
          type: "member_updated",
          workspaceId,
          userId: profile.id,
          name: profile.name,
          avatar: profile.avatar,
        },
      ),
    ),
  );
}
