import { sql } from "drizzle-orm";
import { db, client } from "../db";
import {
  archiveFailedJobs,
  closeQueueClient,
  closeQueueDatabase,
  replayDeadJob,
  QUEUES,
} from "../async/queue";

export async function runQueueDlqCommand(
  argv: string[],
  out: (line: string) => void = console.log,
) {
  const [command, queue, id] = argv;
  if (command === "list" && argv.length === 1) {
    const rows = await db.execute(
      sql`select queue,id,attempts,dead_at,replay_id,replayed_at from queue_dead_letters order by dead_at,id limit 100`,
    );
    out(JSON.stringify(rows));
    return 0;
  }
  if (command === "archive" && argv.length === 1) {
    out(JSON.stringify({ archived: await archiveFailedJobs() }));
    return 0;
  }
  if (
    command === "replay" &&
    argv.length === 3 &&
    Object.values(QUEUES).includes(queue as any) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    const replayId = await replayDeadJob(queue, id);
    out(JSON.stringify({ queue, id, replayId }));
    return replayId ? 0 : 1;
  }
  out("usage: queue:dlq list | archive | replay <queue> <uuid>");
  return 2;
}
if (import.meta.main) {
  try {
    process.exitCode = await runQueueDlqCommand(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.name : "QueueError");
    process.exitCode = 1;
  } finally {
    await closeQueueClient();
    await closeQueueDatabase();
    await client.end();
  }
}
