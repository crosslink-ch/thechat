import { expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { db as fixtures } from '../db/testing';
import { withDatabaseContext } from '../db';
import { users,bots,workspaces,conversations,attachments } from '../db/schema';
import { createWorkspace } from '../services/workspaces';
import { addOwnedBotToWorkspace } from '../services/bot-workspace-memberships';
import { updateBotInstallation } from '../services/bot-installation-access';
import { getAttachmentDownload } from './service';
import type { ObjectStore } from './object-store';

async function fixture() {
  const [owner,botUser]=await fixtures.insert(users).values([{name:'Synthetic download owner'},{name:'Synthetic download bot',type:'bot'}]).returning();
  const workspace=await withDatabaseContext({actorId:owner!.id,scope:'actor'},()=>createWorkspace('Synthetic download revocation',owner!.id));
  const [bot]=await fixtures.insert(bots).values({userId:botUser!.id,ownerId:owner!.id,webhookSecret:'synthetic-download-secret',attachmentAccess:true}).returning();
  await withDatabaseContext({actorId:owner!.id,scope:'actor'},()=>addOwnedBotToWorkspace(bot!.id,workspace.id,owner!.id));
  const [channel]=await fixtures.select().from(conversations).where(eq(conversations.workspaceId,workspace.id));
  const [file]=await fixtures.insert(attachments).values({conversationId:channel!.id,uploaderId:owner!.id,fileName:'synthetic.txt',declaredMediaType:'text/plain',declaredSizeBytes:1,declaredChecksumSha256:'a'.repeat(64),verifiedMediaType:'text/plain',verifiedSizeBytes:1,status:'attached',quarantineKey:'synthetic/pending',cleanKey:'synthetic/clean',cleanVersionId:'synthetic-v1',uploadExpiresAt:new Date(),expiresAt:new Date()}).returning();
  return {owner:owner!,botUser:botUser!,bot:bot!,workspace,file:file!,async close(){
    await fixtures.delete(workspaces).where(eq(workspaces.id,workspace.id));
    await fixtures.delete(users).where(eq(users.id,botUser!.id));
    await fixtures.delete(users).where(eq(users.id,owner!.id));
  }};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const download=(f:Fixture,store:Pick<ObjectStore,'createDownloadRequest'>)=>withDatabaseContext({actorId:f.botUser.id,scope:'actor'},()=>getAttachmentDownload(f.file.id,f.botUser.id,{store:store as ObjectStore}));
const revoke=(f:Fixture)=>withDatabaseContext({actorId:f.owner.id,scope:'actor'},()=>updateBotInstallation(f.workspace.id,f.bot.id,f.owner.id,{enabled:true,channelScope:'all',conversationIds:[],attachmentAccess:false,sharedRuntimeConsent:true,expectedRevision:1}));

test('download issuance denies committed installation attachment revocation before signing',async()=>{
  const f=await fixture();let signs=0;
  try {
    await revoke(f);
    await expect(download(f,{async createDownloadRequest(){signs++;return {method:'GET' as const,headers:{},url:'https://synthetic-download.invalid',expiresAt:new Date()};}})).rejects.toMatchObject({status:403});
    expect(signs).toBe(0);
  } finally {await f.close();}
});

test('signer failure rolls back and releases authorization locks for grant revocation',async()=>{
  const f=await fixture();let signs=0;
  const store={async createDownloadRequest(){signs++;throw new Error('synthetic signer unavailable');}};
  try {
    await expect(download(f,store)).rejects.toThrow('synthetic signer unavailable');
    await revoke(f);
    await expect(download(f,store)).rejects.toMatchObject({status:403});
    expect(signs).toBe(1);
  } finally {await f.close();}
});

for (const boundary of ['global bot safety','canonical attachment deletion','installation grant'] as const) {
  test(`download signing serializes with ${boundary} revocation`,async()=>{
    const f=await fixture();let release!:()=>void,entered!:()=>void,committed=false,signs=0;
    const gate=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    const store={async createDownloadRequest(){signs++;entered();await gate;return {method:'GET' as const,headers:{},url:'https://synthetic-download.invalid/signed',expiresAt:new Date(Date.now()+90000)};}};
    const issued=download(f,store);
    let mutation:Promise<unknown>|undefined;
    try {
      await started;
      mutation=(boundary==='global bot safety'
        ? fixtures.update(bots).set({attachmentAccess:false}).where(eq(bots.id,f.bot.id))
        : boundary==='canonical attachment deletion'
          ? fixtures.update(attachments).set({status:'deleting'}).where(eq(attachments.id,f.file.id))
          : revoke(f)).then(result=>{committed=true;return result;});
      const deadline=Date.now()+5000;let blocked=false;
      while(!committed && Date.now()<deadline) {
        const rows=await fixtures.execute(sql`select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='active' and cardinality(pg_blocking_pids(pid))>0`);
        if(rows.length){blocked=true;break;}await Bun.sleep(20);
      }
      expect(blocked).toBe(true);expect(committed).toBe(false);
    } catch(error) {
      release();await issued;await mutation;await f.close();throw error;
    } finally {release();await issued;await mutation;}
    try {
      expect(signs).toBe(1);
      await expect(download(f,store)).rejects.toMatchObject({status:boundary==='canonical attachment deletion'?409:403});
      expect(signs).toBe(1);
    } finally {await f.close();}
  });
}
