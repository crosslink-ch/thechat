import { setupQueues, closeQueueDatabase } from "../async/queue";
import { client } from "../db";
try {
  await setupQueues();
  console.log("pg-boss 12.38.0 schema and TheChat queues ready");
} finally {
  await closeQueueDatabase();
  await client.end();
}
