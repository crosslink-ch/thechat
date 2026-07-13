import { BOT_QUEUE_NAME, closeBotRuntime, startBotWorker } from "../services/bot-runtime";
import {
  closeDomainEventRuntime,
  startDomainEventRuntime,
} from "../events/runtime";
import { initObservability, shutdownObservability } from "../observability";
import { log } from "../logging";

const workerLog = log.child({ component: "worker" });

async function main() {
  await initObservability("thechat-worker");

  try {
    await startBotWorker();
    await startDomainEventRuntime();
    workerLog.info({ queue: BOT_QUEUE_NAME }, "TheChat bot worker is listening");
    workerLog.info("TheChat PostgreSQL domain-event outbox relay is running");

    await waitForShutdownSignal();
  } finally {
    await Promise.all([closeDomainEventRuntime(), closeBotRuntime()]);
    await shutdownObservability();
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
  await Promise.all([closeDomainEventRuntime(), closeBotRuntime()]);
  await shutdownObservability();
  process.exitCode = 1;
});
