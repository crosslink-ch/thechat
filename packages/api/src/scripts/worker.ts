import { BOT_QUEUE_NAME, closeBotRuntime, startBotWorker } from "../services/bot-runtime";
import {
  closeDomainEventRuntime,
  startDomainEventRuntime,
} from "../events/runtime";
import { initObservability, shutdownObservability } from "../observability";

async function main() {
  await initObservability("thechat-worker");

  try {
    await startBotWorker();
    await startDomainEventRuntime();
    console.log(`TheChat bot worker listening on ${BOT_QUEUE_NAME}`);
    console.log("TheChat PostgreSQL domain-event outbox relay is running");

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
  console.error("TheChat worker failed", error);
  await Promise.all([closeDomainEventRuntime(), closeBotRuntime()]);
  await shutdownObservability();
  process.exitCode = 1;
});
