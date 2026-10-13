import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { botActivitySnapshots, botInvocations, bots, messages } from "../db/schema";
import { requireConversationMutationAccess } from "./conversation-mutation-access";
import { ServiceError } from "./errors";

export const backgroundTaskControlSchema = z.object({version:z.literal(1),action:z.literal("stop"),taskId:z.string().uuid(),sessionId:z.string().min(1).max(255).refine(value => value === value.trim())}).strict();

/** Scope comes from the retained owner binding, never request body/session paths. */
export async function requestBackgroundTaskStop(botId: string, taskId: string, userId: string) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${botId}:${taskId}:stop`}, 0))`);
    const [task] = await tx.select().from(botActivitySnapshots).where(and(eq(botActivitySnapshots.botId,botId),eq(botActivitySnapshots.taskId,taskId))).limit(1);
    if (!task) throw new ServiceError("Activity task not found",404);
    const access = await requireConversationMutationAccess(tx,task.conversationId,userId);
    if (access.senderType !== "human") throw new ServiceError("Human task-control authorization required",403);
    const [bot] = await tx.select().from(bots).where(eq(bots.id,botId)).limit(1);
    if (!bot || bot.kind !== "hermes" || bot.backgroundTaskControlVersion !== 1) throw new ServiceError("Task-scoped stop requires an upgraded owner runtime",409);
    await requireConversationMutationAccess(tx,task.conversationId,bot.userId);
    if (["finished","failed","stopped","unknown"].includes(task.snapshot.parent.state)) throw new ServiceError("Task has no confirmed live owner",409);
    const [existing] = await tx.select({id:botInvocations.id}).from(botInvocations).where(and(eq(botInvocations.botId,botId),inArray(botInvocations.status,["queued","running","claimed","completed"]),sql`${botInvocations.requestJson}->'taskControl'->>'taskId' = ${taskId}`,sql`${botInvocations.requestJson}->'taskControl'->>'sessionId' = ${task.sessionId}`)).limit(1);
    if (existing) return {ok:true as const,taskId,invocationId:existing.id,state:"requested" as const};
    const [trigger] = await tx.insert(messages).values({conversationId:task.conversationId,threadId:task.threadId,senderId:userId,content:"/stop"}).returning({id:messages.id});
    const [invocation] = await tx.insert(botInvocations).values({botId,conversationId:task.conversationId,threadId:task.threadId,triggerMessageId:trigger!.id,adapterKind:"hermes",status:"queued",requestJson:{taskControl:{version:1,action:"stop",taskId,sessionId:task.sessionId}}}).returning({id:botInvocations.id});
    return {ok:true as const,taskId,invocationId:invocation!.id,state:"requested" as const};
  });
}
