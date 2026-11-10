import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import type {
  ChannelMember,
  WorkspaceChannel,
  WsServerEvent,
} from "@thechat/shared";
import { db } from "../db";
import { pendingChatJobs } from "../async/queue";
import {
  attachments,
  botInvocations,
  conversationParticipants,
  conversations,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema";
import { log } from "../logging";
import { publishWsEventToUsers } from "../realtime";
import { currentHermesDispatchTimeoutCutoff } from "./bot-runtime";
import { ServiceError } from "./errors";

const channelLog = log.child({ component: "channels" });

export type ChannelRow = typeof conversations.$inferSelect;
type Reader = Pick<typeof db, "select">;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type MutationOptions = { afterWorkspaceLocked?: () => Promise<void> };

export const MAX_CHANNEL_MEMBER_BATCH = 500;

export type ChannelLifecycleEvent = Extract<
  WsServerEvent,
  {
    type:
      | "channel_created"
      | "channel_renamed"
      | "channel_updated"
      | "channel_joined"
      | "channel_deleted";
  }
>;

type ChannelDelivery = { userIds: string[]; event: ChannelLifecycleEvent };

function isChannelAdminRole(role: string) {
  return role === "admin" || role === "owner";
}

/** Members of the given private channels, oldest member first. */
export async function privateChannelMembers(
  executor: Reader,
  channelIds: string[],
) {
  const byChannel = new Map<string, ChannelMember[]>();
  if (channelIds.length === 0) return byChannel;
  const rows = await executor
    .select({
      conversationId: conversationParticipants.conversationId,
      userId: conversationParticipants.userId,
      role: conversationParticipants.role,
    })
    .from(conversationParticipants)
    .where(inArray(conversationParticipants.conversationId, channelIds))
    .orderBy(
      asc(conversationParticipants.joinedAt),
      asc(conversationParticipants.userId),
    );
  for (const id of channelIds) byChannel.set(id, []);
  for (const row of rows) {
    byChannel.get(row.conversationId)!.push({
      userId: row.userId,
      role: isChannelAdminRole(row.role) ? "admin" : "member",
    });
  }
  return byChannel;
}

/** The channel as its members see it, including who is in a private one. */
export async function describeChannel(
  executor: Reader,
  channel: ChannelRow,
): Promise<WorkspaceChannel> {
  if (!channel.workspaceId || !channel.name) {
    throw new ServiceError("Channel data is incomplete", 500);
  }
  const members = channel.isPrivate
    ? (await privateChannelMembers(executor, [channel.id])).get(channel.id)
    : undefined;
  return {
    id: channel.id,
    workspaceId: channel.workspaceId,
    name: channel.name,
    title: channel.title,
    isPrivate: channel.isPrivate,
    ...(members ? { members } : {}),
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}

/** Everyone who can see the channel: its participants, or the workspace. */
export async function channelAudience(executor: Reader, channel: ChannelRow) {
  if (channel.isPrivate) {
    const participants = await executor
      .select({ userId: conversationParticipants.userId })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, channel.id));
    return participants.map((participant) => participant.userId);
  }
  const members = await executor
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, channel.workspaceId!));
  return members.map((member) => member.userId);
}

export async function publishChannelLifecycleEvent(
  targetUserIds: string[],
  event: ChannelLifecycleEvent,
) {
  try {
    await publishWsEventToUsers(targetUserIds, event);
  } catch (error) {
    // The channel mutation has already committed. Realtime fanout failure must
    // not turn a successful REST mutation into an ambiguous client failure.
    channelLog.warn(
      {
        err: error,
        eventType: event.type,
        workspaceId: event.workspaceId,
      },
      "channel.realtime_publish_failed",
    );
  }
}

export async function publishChannelDeliveries(deliveries: ChannelDelivery[]) {
  for (const delivery of deliveries) {
    await publishChannelLifecycleEvent(delivery.userIds, delivery.event);
  }
}

/**
 * Public channels are managed by workspace owners and admins. A private
 * channel is managed by its own admins, and by a workspace owner or admin
 * only when they are in it: managing the workspace does not open the channel.
 */
export async function requireChannelManager(
  executor: Reader,
  workspaceId: string,
  userId: string,
  conversationId: string,
  isPrivate: boolean,
) {
  const [membership] = await executor
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new ServiceError("You are not a member of this workspace", 403);
  }
  const managesWorkspace =
    membership.role === "owner" || membership.role === "admin";
  if (isPrivate) {
    const [participant] = await executor
      .select({ role: conversationParticipants.role })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.userId, userId),
        ),
      )
      .limit(1);
    if (!participant) {
      throw new ServiceError(
        "You are not a participant of this conversation",
        403,
      );
    }
    if (!managesWorkspace && !isChannelAdminRole(participant.role)) {
      throw new ServiceError(
        "Only channel admins can manage this channel",
        403,
      );
    }
    return;
  }
  if (!managesWorkspace) {
    throw new ServiceError(
      "Only workspace owners and admins can manage channels",
      403,
    );
  }
}

/**
 * Refuses deletion while a bot is still working in the channel or while it
 * holds attachments. The caller must hold the channel row lock.
 */
export async function assertChannelDeletable(tx: Tx, channelId: string) {
  const hermesDispatchCutoff = currentHermesDispatchTimeoutCutoff();
  const [activeInvocation] = await tx
    .select({ id: botInvocations.id })
    .from(botInvocations)
    .where(
      and(
        eq(botInvocations.conversationId, channelId),
        or(
          and(
            eq(botInvocations.status, "queued"),
            or(
              ne(botInvocations.adapterKind, "hermes"),
              gt(botInvocations.createdAt, hermesDispatchCutoff),
            ),
          ),
          eq(botInvocations.status, "running"),
          and(
            eq(botInvocations.status, "claimed"),
            sql`NULLIF(${botInvocations.responseJson}->'completion'->>'type', '') IS NULL`,
            sql`COALESCE(${botInvocations.responseJson}->>'silent', 'false') <> 'true'`,
          ),
        ),
      ),
    )
    .limit(1);

  const [pendingTargetedEvent] = await pendingChatJobs(tx, channelId);

  if (activeInvocation || pendingTargetedEvent) {
    throw new ServiceError(
      "Wait for active bot runs to finish before deleting this channel",
      409,
    );
  }

  // Attachment rows own private object-store coordinates. Cascading them
  // away would make their exact S3 versions impossible to clean up safely.
  const [attachment] = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.conversationId, channelId))
    .limit(1);
  if (attachment) {
    throw new ServiceError("Channels with attachments cannot be deleted", 409);
  }
}

/** Locks the workspace, then the channel, in the order every mutation uses. */
async function lockChannel(
  tx: Tx,
  conversationId: string,
  options: MutationOptions,
) {
  const [candidate] = await tx
    .select({ workspaceId: conversations.workspaceId })
    .from(conversations)
    .where(
      and(eq(conversations.id, conversationId), eq(conversations.type, "group")),
    )
    .limit(1);
  if (!candidate?.workspaceId) {
    throw new ServiceError("Channel not found", 404);
  }

  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, candidate.workspaceId))
    .for("update")
    .limit(1);
  if (!workspace) {
    throw new ServiceError("Channel not found", 404);
  }

  await options.afterWorkspaceLocked?.();

  const [channel] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.type, "group"),
        eq(conversations.workspaceId, workspace.id),
      ),
    )
    .for("update")
    .limit(1);
  if (!channel?.workspaceId) {
    throw new ServiceError("Channel not found", 404);
  }
  return { channel, workspaceId: workspace.id };
}

async function participantsOf(tx: Tx, channelId: string) {
  return tx
    .select({
      userId: conversationParticipants.userId,
      role: conversationParticipants.role,
      type: users.type,
    })
    .from(conversationParticipants)
    .innerJoin(users, eq(users.id, conversationParticipants.userId))
    .where(eq(conversationParticipants.conversationId, channelId))
    .orderBy(
      asc(conversationParticipants.joinedAt),
      asc(conversationParticipants.userId),
    );
}

/** A caller who cannot see the channel must not learn that it exists. */
async function requireParticipant(tx: Tx, channelId: string, userId: string) {
  const [participant] = await tx
    .select({ role: conversationParticipants.role })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, channelId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);
  if (!participant) {
    throw new ServiceError(
      "You are not a participant of this conversation",
      403,
    );
  }
  return participant;
}

/**
 * Call after someone left a private channel. A channel nobody can open any
 * more is deleted, which also frees its name; otherwise the member who has
 * been in it longest becomes admin when no admin is left.
 *
 * `strict` refuses the departure when the emptied channel cannot be deleted.
 * Removal from the whole workspace is not strict: it must not fail because of
 * a channel the remover may not be able to see, so such a channel is kept.
 */
export async function settlePrivateChannelAfterDeparture(
  tx: Tx,
  channel: ChannelRow,
  { strict }: { strict: boolean },
): Promise<{ deleted: boolean; remainingUserIds: string[] }> {
  const remaining = await participantsOf(tx, channel.id);
  const remainingUserIds = remaining.map((participant) => participant.userId);
  const people = remaining.filter((participant) => participant.type === "human");

  if (people.length === 0) {
    try {
      await assertChannelDeletable(tx, channel.id);
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      if (strict) {
        throw new ServiceError(
          `The channel would be left without people and has to be deleted. ${error.message}`,
          error.status,
        );
      }
      channelLog.warn(
        { channelId: channel.id, reason: error.message },
        "channel.empty_private_channel_kept",
      );
      return { deleted: false, remainingUserIds };
    }
    await tx.delete(conversations).where(eq(conversations.id, channel.id));
    return { deleted: true, remainingUserIds };
  }

  await promoteLongestStandingPerson(tx, channel.id, people);
  return { deleted: false, remainingUserIds };
}

/** Makes the first of the given people admin when none of them is one. */
async function promoteLongestStandingPerson(
  tx: Tx,
  channelId: string,
  people: Array<{ userId: string; role: string }>,
) {
  if (people.some((participant) => isChannelAdminRole(participant.role))) return;
  await tx
    .update(conversationParticipants)
    .set({ role: "admin" })
    .where(
      and(
        eq(conversationParticipants.conversationId, channelId),
        eq(conversationParticipants.userId, people[0]!.userId),
      ),
    );
}

/**
 * Call after creating a private channel. Its creator is its admin, but a bot
 * cannot run a channel: one created by a bot is handed to a person in it, and
 * one without any person is refused.
 */
export async function requirePrivateChannelAdmin(tx: Tx, channelId: string) {
  const people = (await participantsOf(tx, channelId)).filter(
    (participant) => participant.type === "human",
  );
  if (people.length === 0) {
    throw new ServiceError("A private channel needs at least one person", 400);
  }
  await promoteLongestStandingPerson(tx, channelId, people);
}

/**
 * Settles every private channel in the workspace that the given user was just
 * removed from. Returns the realtime events to publish after commit.
 */
export async function settlePrivateChannelsAfterWorkspaceDeparture(
  tx: Tx,
  workspaceId: string,
  channelIds: string[],
): Promise<ChannelDelivery[]> {
  if (channelIds.length === 0) return [];
  const channels = await tx
    .select()
    .from(conversations)
    .where(
      and(
        inArray(conversations.id, channelIds),
        eq(conversations.workspaceId, workspaceId),
        eq(conversations.type, "group"),
        eq(conversations.isPrivate, true),
      ),
    )
    .orderBy(asc(conversations.id))
    .for("update");

  const deliveries: ChannelDelivery[] = [];
  for (const channel of channels) {
    const settled = await settlePrivateChannelAfterDeparture(tx, channel, {
      strict: false,
    });
    if (settled.remainingUserIds.length === 0) continue;
    deliveries.push({
      userIds: settled.remainingUserIds,
      event: settled.deleted
        ? { type: "channel_deleted", workspaceId, channelId: channel.id }
        : {
            type: "channel_updated",
            workspaceId,
            channel: await describeChannel(tx, channel),
          },
    });
  }
  return deliveries;
}

/** Any member of a private channel can bring in other workspace members. */
export async function addChannelMembers(
  conversationId: string,
  actorUserId: string,
  userIds: string[],
  options: MutationOptions = {},
) {
  const requested = [...new Set(userIds)];
  if (requested.length === 0) {
    throw new ServiceError("Choose at least one person to add", 400);
  }
  if (requested.length > MAX_CHANNEL_MEMBER_BATCH) {
    throw new ServiceError("Too many people in one request", 400);
  }

  const result = await db.transaction(async (tx) => {
    const { channel, workspaceId } = await lockChannel(tx, conversationId, options);
    if (channel.isPrivate) {
      await requireParticipant(tx, channel.id, actorUserId);
    }
    const [actorMembership] = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, actorUserId),
        ),
      )
      .limit(1);
    if (!actorMembership) {
      throw new ServiceError("You are not a member of this workspace", 403);
    }
    if (!channel.isPrivate) {
      throw new ServiceError(
        "Everyone in the workspace is already in a public channel",
        400,
      );
    }

    const eligible = await tx
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          inArray(workspaceMembers.userId, requested),
        ),
      );
    if (eligible.length !== requested.length) {
      throw new ServiceError(
        "Every private channel member must belong to this workspace",
        400,
      );
    }

    const before = await participantsOf(tx, channel.id);
    const present = new Set(before.map((participant) => participant.userId));
    const added = requested.filter((userId) => !present.has(userId));
    if (added.length > 0) {
      await tx.insert(conversationParticipants).values(
        added.map((userId) => ({
          conversationId: channel.id,
          userId,
          role: "member" as const,
        })),
      );
    }
    return {
      channel: await describeChannel(tx, channel),
      workspaceId,
      added,
      existing: [...present],
    };
  });

  if (result.added.length > 0) {
    await publishChannelDeliveries([
      {
        userIds: result.added,
        event: {
          type: "channel_joined",
          workspaceId: result.workspaceId,
          channel: result.channel,
        },
      },
      {
        userIds: result.existing,
        event: {
          type: "channel_updated",
          workspaceId: result.workspaceId,
          channel: result.channel,
        },
      },
    ]);
  }
  return result.channel;
}

/**
 * Removes someone from a private channel. Anyone can remove themselves
 * (leave); removing somebody else takes a channel manager.
 */
export async function removeChannelMember(
  conversationId: string,
  actorUserId: string,
  targetUserId: string,
  options: MutationOptions = {},
) {
  const result = await db.transaction(async (tx) => {
    const { channel, workspaceId } = await lockChannel(tx, conversationId, options);
    if (channel.isPrivate) {
      await requireParticipant(tx, channel.id, actorUserId);
    }
    if (targetUserId !== actorUserId) {
      await requireChannelManager(
        tx,
        workspaceId,
        actorUserId,
        channel.id,
        channel.isPrivate,
      );
    }
    if (!channel.isPrivate) {
      throw new ServiceError(
        "A public channel always includes everyone in the workspace",
        400,
      );
    }

    const removed = await tx
      .delete(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, channel.id),
          eq(conversationParticipants.userId, targetUserId),
        ),
      )
      .returning({ userId: conversationParticipants.userId });
    if (removed.length === 0) {
      throw new ServiceError("That person is not in this channel", 404);
    }

    const settled = await settlePrivateChannelAfterDeparture(tx, channel, {
      strict: true,
    });
    return {
      workspaceId,
      channelId: channel.id,
      deleted: settled.deleted,
      remainingUserIds: settled.remainingUserIds,
      channel: settled.deleted ? null : await describeChannel(tx, channel),
    };
  });

  const gone: ChannelLifecycleEvent = {
    type: "channel_deleted",
    workspaceId: result.workspaceId,
    channelId: result.channelId,
  };
  await publishChannelDeliveries([
    { userIds: [targetUserId], event: gone },
    {
      userIds: result.remainingUserIds,
      event: result.channel
        ? {
            type: "channel_updated",
            workspaceId: result.workspaceId,
            channel: result.channel,
          }
        : gone,
    },
  ]);
  return { ok: true as const, channelDeleted: result.deleted, channel: result.channel };
}

/** Makes a person a channel admin, or an ordinary member again. */
export async function setChannelMemberRole(
  conversationId: string,
  actorUserId: string,
  targetUserId: string,
  role: "member" | "admin",
  options: MutationOptions = {},
) {
  const result = await db.transaction(async (tx) => {
    const { channel, workspaceId } = await lockChannel(tx, conversationId, options);
    await requireChannelManager(
      tx,
      workspaceId,
      actorUserId,
      channel.id,
      channel.isPrivate,
    );
    if (!channel.isPrivate) {
      throw new ServiceError(
        "Public channels are managed by workspace owners and admins",
        400,
      );
    }

    const participants = await participantsOf(tx, channel.id);
    const target = participants.find(
      (participant) => participant.userId === targetUserId,
    );
    if (!target) {
      throw new ServiceError("That person is not in this channel", 404);
    }
    if (target.type !== "human") {
      throw new ServiceError("Only people can be channel admins", 400);
    }
    if (
      role === "member" &&
      !participants.some(
        (participant) =>
          participant.userId !== targetUserId &&
          participant.type === "human" &&
          isChannelAdminRole(participant.role),
      )
    ) {
      throw new ServiceError("A private channel needs at least one admin", 400);
    }

    await tx
      .update(conversationParticipants)
      .set({ role })
      .where(
        and(
          eq(conversationParticipants.conversationId, channel.id),
          eq(conversationParticipants.userId, targetUserId),
        ),
      );
    return {
      channel: await describeChannel(tx, channel),
      workspaceId,
      audience: participants.map((participant) => participant.userId),
    };
  });

  await publishChannelLifecycleEvent(result.audience, {
    type: "channel_updated",
    workspaceId: result.workspaceId,
    channel: result.channel,
  });
  return result.channel;
}

/**
 * Switches a channel between public and private.
 *
 * Making it public adds everyone in the workspace, who can then read its whole
 * history. Making it private keeps the people already in it; whoever joins the
 * workspace afterwards is not added.
 */
export async function setChannelVisibility(
  conversationId: string,
  actorUserId: string,
  isPrivate: boolean,
  options: MutationOptions = {},
) {
  const result = await db.transaction(async (tx) => {
    const { channel, workspaceId } = await lockChannel(tx, conversationId, options);
    await requireChannelManager(
      tx,
      workspaceId,
      actorUserId,
      channel.id,
      channel.isPrivate,
    );
    if (channel.isPrivate === isPrivate) {
      return {
        channel: await describeChannel(tx, channel),
        workspaceId,
        joined: [] as string[],
        existing: [] as string[],
      };
    }
    if (isPrivate && channel.name === "general") {
      // New workspace members land here; it is the one channel all can rely on.
      throw new ServiceError("The general channel has to stay public", 400);
    }
    if (isPrivate) {
      // Someone who joins the workspace is added to its public channels only.
      const [otherPublicChannel] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, workspaceId),
            eq(conversations.type, "group"),
            eq(conversations.isPrivate, false),
            ne(conversations.id, channel.id),
          ),
        )
        .limit(1);
      if (!otherPublicChannel) {
        throw new ServiceError(
          "A workspace needs at least one public channel",
          400,
        );
      }
    }

    const before = await participantsOf(tx, channel.id);
    const present = new Set(before.map((participant) => participant.userId));
    const [updated] = await tx
      .update(conversations)
      .set({ isPrivate })
      .where(eq(conversations.id, channel.id))
      .returning();

    let joined: string[] = [];
    if (isPrivate) {
      // From here on the channel is run by its own admins: the person who
      // made it private, not whoever holds a workspace role.
      await tx
        .update(conversationParticipants)
        .set({ role: "member" })
        .where(eq(conversationParticipants.conversationId, channel.id));
      await tx
        .insert(conversationParticipants)
        .values({ conversationId: channel.id, userId: actorUserId, role: "admin" })
        .onConflictDoUpdate({
          target: [
            conversationParticipants.conversationId,
            conversationParticipants.userId,
          ],
          set: { role: "admin" },
        });
      present.add(actorUserId);
    } else {
      // A public channel mirrors the workspace: everyone, with workspace roles.
      const members = await tx
        .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId));
      for (const member of members) {
        await tx
          .insert(conversationParticipants)
          .values({
            conversationId: channel.id,
            userId: member.userId,
            role: member.role,
          })
          .onConflictDoUpdate({
            target: [
              conversationParticipants.conversationId,
              conversationParticipants.userId,
            ],
            set: { role: member.role },
          });
      }
      joined = members
        .map((member) => member.userId)
        .filter((userId) => !present.has(userId));
    }

    return {
      channel: await describeChannel(tx, updated!),
      workspaceId,
      joined,
      existing: [...present],
    };
  });

  await publishChannelDeliveries([
    {
      userIds: result.joined,
      event: {
        type: "channel_joined",
        workspaceId: result.workspaceId,
        channel: result.channel,
      },
    },
    {
      userIds: result.existing,
      event: {
        type: "channel_updated",
        workspaceId: result.workspaceId,
        channel: result.channel,
      },
    },
  ]);
  return result.channel;
}
