import { BOT_QUEUE_NAME, closeBotRuntime, startBotWorker } from "../services/bot-runtime";
import { initObservability, shutdownObservability } from "../observability";

async function main() {
  await initObservability("thechat-worker");

  try {
    await startBotWorker();
    console.log(`TheChat bot worker listening on ${BOT_QUEUE_NAME}`);

    await waitForShutdownSignal();
  } finally {
    await closeBotRuntime();
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
  console.error("TheChat bot worker failed", error);
  await closeBotRuntime();
  await shutdownObservability();
  process.exitCode = 1;
});
