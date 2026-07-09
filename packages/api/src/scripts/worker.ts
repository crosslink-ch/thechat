import { BOT_QUEUE_NAME, closeBotRuntime, startBotWorker } from "../services/bot-runtime";
import {
  closeDomainEventRuntime,
  startDomainEventRuntime,
} from "../events/runtime";
import { loadDomainEventsConfig } from "../events/config";
import { initObservability, shutdownObservability } from "../observability";
import { waitForWorkerStop } from "./worker-lifecycle";

async function main() {
  await initObservability("thechat-worker");

  try {
    const domainEventsConfig = loadDomainEventsConfig();
    await startBotWorker();
    console.log(`TheChat bot worker listening on ${BOT_QUEUE_NAME}`);
    const domainEventRuntime = await startDomainEventRuntime({
      config: domainEventsConfig,
    });
    console.log(
      `TheChat domain event runtime started with driver ${domainEventsConfig.driver}`,
    );

    await waitForWorkerStop(domainEventRuntime);
  } finally {
    await closeDomainEventRuntime();
    await closeBotRuntime();
    await shutdownObservability();
  }
}

main().catch(async (error) => {
  console.error("TheChat bot worker failed", error);
  await closeDomainEventRuntime();
  await closeBotRuntime();
  await shutdownObservability();
  process.exitCode = 1;
});
