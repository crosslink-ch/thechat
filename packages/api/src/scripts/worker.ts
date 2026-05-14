import { BOT_QUEUE_NAME, closeBotRuntime, startBotWorker } from "../services/bot-runtime";

async function main() {
  await startBotWorker();
  console.log(`TheChat bot worker listening on ${BOT_QUEUE_NAME}`);

  await waitForShutdownSignal();
  await closeBotRuntime();
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
  process.exitCode = 1;
});
