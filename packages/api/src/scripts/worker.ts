import {
  BOT_QUEUE_NAME,
  closeBotRuntime,
  startBotWorker,
} from "../services/bot-runtime";
import {
  closeDomainEventRuntime,
  startDomainEventRuntime,
} from "../events/runtime";
import { initObservability, shutdownObservability } from "../observability";
import { log } from "../logging";
import {
  getQueueClient,
  closeQueueClient,
  closeQueueDatabase,
} from "../async/queue";
import { client } from "../db";
import {
  closeAttachmentCleanup,
  startAttachmentCleanup,
} from "../attachments/cleanup";
import {
  closeBotRequestExpirySweep,
  startBotRequestExpirySweep,
} from "../bot-requests/expiry";
import { closePushRuntime, startPushWorker } from "../push/jobs";

const workerLog = log.child({ component: "worker" });

async function main() {
  await initObservability("thechat-worker");

  try {
    await getQueueClient();
    await startBotWorker();
    await startPushWorker();
    await startDomainEventRuntime();
    void startAttachmentCleanup();
    void startBotRequestExpirySweep();
    workerLog.info(
      { queue: BOT_QUEUE_NAME },
      "TheChat bot worker is listening",
    );
    workerLog.info("TheChat pg-boss durable queues are running");

    await waitForShutdownSignal();
  } finally {
    await Promise.all([
      closeAttachmentCleanup(),
      closeBotRequestExpirySweep(),
      closeDomainEventRuntime(),
      closeBotRuntime(),
      closePushRuntime(),
    ]);
    await shutdownObservability();
    await closeQueueClient();
    await closeQueueDatabase();
    await client.end();
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const shutdown = () => resolve();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

main().catch(async (error) => {
  workerLog.error({ err: error }, "TheChat worker failed");
  await Promise.all([
    closeAttachmentCleanup(),
    closeBotRequestExpirySweep(),
    closeDomainEventRuntime(),
    closeBotRuntime(),
    closePushRuntime(),
  ]);
  await shutdownObservability();
  process.exitCode = 1;
});
