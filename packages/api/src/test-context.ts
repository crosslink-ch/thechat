import { eq } from 'drizzle-orm';
import { db as fixtures } from './db/testing';
import { bots, workspaceMembers, conversations, conversationParticipants } from './db/schema';
import { withDatabaseContext, withWorkerDatabaseContext } from './db';
/** Test-only identity lookup. Execution still uses the restricted bot actor role. */
export async function asFixtureBot<T>(botId:string, operation:()=>Promise<T>):Promise<T> {
 const [bot]=await fixtures.select({userId:bots.userId}).from(bots).where(eq(bots.id,botId)).limit(1);
 if(!bot)throw new Error('Missing synthetic bot identity');
 return withDatabaseContext({actorId:bot.userId,scope:'actor'},operation);
}
/** Explicit synthetic membership setup, not a service running as the owner. */
export async function joinFixtureWorkspace(workspaceId:string,userId:string) {
 await fixtures.transaction(async tx => {
  await tx.insert(workspaceMembers).values({workspaceId,userId,role:'member'}).onConflictDoNothing();
  const channels=await tx.select({id:conversations.id}).from(conversations).where(eq(conversations.workspaceId,workspaceId));
  if(channels.length)await tx.insert(conversationParticipants).values(channels.map(c=>({conversationId:c.id,userId,role:'member' as const}))).onConflictDoNothing();
 });
 return {success:true};
}
/** Explicit fixture maintenance authority stays active until background shutdown,
 * exactly like the real worker main. Startup acknowledgement is not its lifetime. */
export async function holdFixtureWorkerContext(start:()=>Promise<unknown>) {
 let ready!:()=>void, failed!:(e:unknown)=>void, stop!:()=>void;
 const started=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});
 const shutdown=new Promise<void>(resolve=>{stop=resolve;});
 const lifetime=withWorkerDatabaseContext(async()=>{try {await start();ready();await shutdown;}catch(error){failed(error);throw error;}});
 void lifetime.catch(()=>undefined);
 await started;
 return async()=>{stop();await lifetime;};
}
