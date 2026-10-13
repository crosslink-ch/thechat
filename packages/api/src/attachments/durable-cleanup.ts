import { sql } from "drizzle-orm";
import { db } from "../db";
import { attachments } from "../db/schema";
import type { ObjectStore } from "./object-store";

type Executor = Pick<typeof db, "execute">;
export async function persistObjectCleanup(executor: Executor, attachmentId: string, key: string, versionId: string, requested = true) {
  await executor.execute(sql`insert into attachment_object_cleanup(attachment_id,object_key,version_id,requested)
    values (${attachmentId},${key},${versionId},${requested}) on conflict(attachment_id,object_key,version_id)
    do update set requested=attachment_object_cleanup.requested or excluded.requested`);
}

export async function drainAttachmentObjectCleanup(attachmentId: string, store: ObjectStore) {
  const rows = await db.execute<{ object_key: string; version_id: string }>(sql`
    select object_key,version_id from attachment_object_cleanup
    where attachment_id=${attachmentId} and requested and completed_at is null order by object_key`);
  for (const row of rows) {
    await store.deleteObject({ key: row.object_key, versionId: row.version_id });
    await db.execute(sql`update attachment_object_cleanup set completed_at=now()
      where attachment_id=${attachmentId} and object_key=${row.object_key} and version_id=${row.version_id}`);
  }
  await db.execute(sql`update workspace_attachment_charges set released_at=now()
    where attachment_id=${attachmentId} and cleanup_requested and not exists (
      select 1 from attachment_object_cleanup where attachment_id=${attachmentId} and completed_at is null)`);
}

// This polling path is independent of event delivery and canonical FK lifetime.
export async function retryDurableObjectCleanup(store: ObjectStore, limit = 100) {
  await db.execute(sql`update attachment_object_cleanup o set requested=true where not requested and completed_at is null
    and created_at<now()-interval '10 minutes' and not exists (
      select 1 from attachments a where a.id=o.attachment_id and a.clean_key=o.object_key and a.clean_version_id=o.version_id
        and a.status in ('ready','attached'))`);
  const pending = await db.execute<{ attachment_id: string }>(sql`
    select attachment_id from (
      select attachment_id,created_at as queued_at from attachment_object_cleanup where requested and completed_at is null
      union all
      select attachment_id,capability_until as queued_at from workspace_attachment_charges
        where cleanup_requested and released_at is null and capability_until<=now()
    ) candidates group by attachment_id order by min(queued_at) limit ${limit}`);
  let failures = 0;
  for (const { attachment_id: id } of pending) {
    try {
      await drainAttachmentObjectCleanup(id, store);
      await db.update(attachments).set({ status: "deleted", deletedAt: new Date(),
        cleanVersionId: null, quarantineVersionId: null }).where(sql`${attachments.id}=${id} and ${attachments.status}='deleting'`);
    } catch { failures++; } // Keep each failed version pending; don't starve the rest.
  }
  return { attempted: pending.length, failures };
}
