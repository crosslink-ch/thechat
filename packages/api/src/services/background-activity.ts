import { z } from "zod";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { BackgroundActivityInput, BackgroundActivityPublic } from "@thechat/shared";
import { db } from "../db";
import { botActivityReceipts, botActivitySnapshots, botInvocations, bots, messages, users } from "../db/schema";
import { ServiceError } from "./errors";
import { requireConversationMutationAccess } from "./conversation-mutation-access";
import { enqueueDomainEvent } from "../events/outbox";
const token = z.string().min(1).max(255).refine(v => v === v.trim());
const date = z.string().datetime({offset:true});
const action = z.string().max(300).nullable();
export const backgroundActivitySchema = z.object({
  schemaVersion: z.literal(1), eventId: z.string().uuid(), taskId: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  originInvocationId: z.string().uuid(), sessionId: token, occurredAt: date,
  parent: z.object({state:z.enum(["working","waiting_worker","waiting_user","waiting_external","verifying","finished","failed","stopped","unknown"]),action,updatedAt:date}).strict(),
  workers: z.array(z.object({id:token,kind:z.enum(["subagent","process"]),parentId:token.nullable(),goal:z.string().max(300),state:z.enum(["running","waiting","finished","failed","stopped","unknown"]),action,startedAt:date,updatedAt:date,lastActionAt:date.nullable()}).strict()).max(32),
  activities: z.array(z.object({id:token,workerId:token.nullable(),toolName:z.string().min(1).max(100),state:z.enum(["running","finished","failed","stopped","unknown"]),startedAt:date,finishedAt:date.nullable()}).strict()).max(40),
}).strict();
export async function publishBackgroundActivity(botId: string, input: BackgroundActivityInput) {
  const contentHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return db.transaction(async tx => {
    // Per-bot serialization also fences event-ID reuse across tasks.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${botId}, 0))`);
    const [current] = await tx.select().from(botActivitySnapshots).where(and(eq(botActivitySnapshots.botId,botId),eq(botActivitySnapshots.taskId,input.taskId))).limit(1);
    const [bot] = await tx.select({userId:bots.userId}).from(bots).where(eq(bots.id,botId)).limit(1);
    if (!bot) throw new ServiceError("Bot not found",403);
    if (current) await requireConversationMutationAccess(tx,current.conversationId,bot.userId);
    if (current && (current.sessionId !== input.sessionId || current.originInvocationId !== input.originInvocationId)) throw new ServiceError("Activity binding is immutable",409);
    const [receipt] = await tx.select().from(botActivityReceipts).where(and(eq(botActivityReceipts.botId,botId),or(eq(botActivityReceipts.eventId,input.eventId),and(eq(botActivityReceipts.taskId,input.taskId),eq(botActivityReceipts.sequence,String(input.sequence)))))).limit(1);
    if (receipt) {
      if (receipt.eventId !== input.eventId || receipt.taskId !== input.taskId || receipt.sequence !== String(input.sequence) || receipt.contentHash !== contentHash) throw new ServiceError("Conflicting activity retry",409);
      return {ok:true as const,taskId:input.taskId,sequence:input.sequence};
    }
    if (current && current.snapshot.sequence > input.sequence) {
      await tx.insert(botActivityReceipts).values({botId,taskId:input.taskId,eventId:input.eventId,sequence:String(input.sequence),contentHash});
      return {ok:true as const,taskId:input.taskId,sequence:input.sequence};
    }
    if (current) {
      const terminal = (state:string) => ["finished","failed","stopped"].includes(state);
      if (terminal(current.snapshot.parent.state) && current.snapshot.parent.state !== input.parent.state) throw new ServiceError("Terminal activity task cannot reopen",409);
      for (const previous of current.snapshot.workers) {
        const next = input.workers.find(worker => worker.id === previous.id);
        if (next && terminal(previous.state) && previous.state !== next.state) throw new ServiceError("Terminal activity worker cannot reopen",409);
      }
    }
    const origin = current ? {...current,botUserId:bot.userId} : (await tx.select({conversationId:botInvocations.conversationId,threadId:botInvocations.threadId,requesterUserId:messages.senderId,botUserId:bots.userId})
      .from(botInvocations).innerJoin(bots,eq(bots.id,botInvocations.botId)).innerJoin(messages,eq(messages.id,botInvocations.triggerMessageId))
      .where(and(eq(botInvocations.id,input.originInvocationId),eq(botInvocations.botId,botId))).limit(1))[0];
    if (!origin) throw new ServiceError("Origin invocation not found",404);
    await requireConversationMutationAccess(tx,origin.conversationId,origin.botUserId);
    const workers = [...input.workers, ...(current?.snapshot.workers ?? []).filter(worker => ["finished","failed","stopped"].includes(worker.state) && !input.workers.some(next => next.id === worker.id))];
    if (workers.length > 32) throw new ServiceError("Activity worker identity limit exceeded",409);
    const projected = {...input,workers};
    await tx.insert(botActivitySnapshots).values({botId,taskId:input.taskId,originInvocationId:input.originInvocationId,conversationId:origin.conversationId,threadId:origin.threadId,requesterUserId:origin.requesterUserId,sessionId:input.sessionId,snapshot:projected}).onConflictDoUpdate({target:[botActivitySnapshots.botId,botActivitySnapshots.taskId],set:{snapshot:projected,observedAt:new Date()}});
    await tx.insert(botActivityReceipts).values({botId,taskId:input.taskId,eventId:input.eventId,sequence:String(input.sequence),contentHash});
    await enqueueDomainEvent(tx,{id:crypto.randomUUID(),type:"hermes.activity.changed",version:1,aggregate:{type:"background_task",id:input.taskId},actor:{type:"bot",id:bot.userId},occurredAt:new Date().toISOString(),payload:{conversationId:origin.conversationId}},{partitionKey:`${origin.conversationId}:activity`});
    return {ok:true as const,taskId:input.taskId,sequence:input.sequence};
  });
}
export async function listBackgroundActivity(conversationId: string, userId: string): Promise<BackgroundActivityPublic[]> {
  return db.transaction(async tx => {
  await requireConversationMutationAccess(tx,conversationId,userId);
  const retainedSince = new Date(Date.now()-7*86_400_000);
  await tx.execute(sql`DELETE FROM bot_activity_snapshots WHERE (bot_id,task_id) IN (SELECT bot_id,task_id FROM bot_activity_snapshots WHERE conversation_id=${conversationId} AND observed_at < ${retainedSince.toISOString()} LIMIT 64)`);
  const rows = await tx.select({row:botActivitySnapshots,botUserId:bots.userId,botName:users.name,controlVersion:bots.backgroundTaskControlVersion}).from(botActivitySnapshots).innerJoin(bots,eq(bots.id,botActivitySnapshots.botId)).innerJoin(users,eq(users.id,bots.userId)).where(and(eq(botActivitySnapshots.conversationId,conversationId),gt(botActivitySnapshots.observedAt,retainedSince),or(sql`${botActivitySnapshots.snapshot}->'parent'->>'state' NOT IN ('finished','failed','stopped')`,gt(botActivitySnapshots.observedAt,new Date(Date.now()-86_400_000))))).orderBy(desc(botActivitySnapshots.observedAt)).limit(64);
  return rows.map(({row,botUserId,botName,controlVersion}) => ({canStop:controlVersion===1 && !["unknown","finished","failed","stopped"].includes(row.snapshot.parent.state),botId:row.botId,botUserId,botName,conversationId:row.conversationId,threadId:row.threadId,taskId:row.taskId,sessionId:row.sessionId,sequence:row.snapshot.sequence,originInvocationId:row.originInvocationId,observedAt:row.observedAt.toISOString(),parent:row.snapshot.parent,workers:row.snapshot.workers,activities:row.snapshot.activities}));
  }).catch(error => {
    // New derived visibility must not change legacy interaction/foreground reads.
    if (error instanceof ServiceError && error.status === 403) return [];
    throw error;
  });
}
