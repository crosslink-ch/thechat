import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { conversationParticipants, conversations, workspaceMembers } from "../db/schema";
import { publishWsEventToUsers } from "../realtime";
import { domainEventEnvelopeSchema } from "./envelope";
import type { DomainEventHandler } from "./registry";
const schema = domainEventEnvelopeSchema.extend({type:z.literal("hermes.activity.changed"),version:z.literal(1),payload:z.object({conversationId:z.string().uuid()}).strict()});
/** Payload-free invalidation; readers must authorize current membership again. */
export function createBackgroundActivityChangedHandler(): DomainEventHandler<z.infer<typeof schema>> {
 return {type:"hermes.activity.changed",version:1,parse:value => schema.parse(value),handle:async event => {
  const participants = await db.select({userId:conversationParticipants.userId}).from(conversationParticipants)
   .innerJoin(conversations,eq(conversations.id,conversationParticipants.conversationId))
   .leftJoin(workspaceMembers,and(eq(workspaceMembers.workspaceId,conversations.workspaceId),eq(workspaceMembers.userId,conversationParticipants.userId)))
   .where(and(eq(conversationParticipants.conversationId,event.payload.conversationId),or(isNull(conversations.workspaceId),eq(workspaceMembers.userId,conversationParticipants.userId))));
  await publishWsEventToUsers(participants.map(row => row.userId),{type:"bot_activity_changed",conversationId:event.payload.conversationId});
 }};
}
