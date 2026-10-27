import { cutoverLegacyQueues } from "../async/cutover";
import { closeQueueClient, closeQueueDatabase } from "../async/queue";
import { client } from "../db";
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--stopped", "--quarantine-active"].includes(arg)))
    throw Error("usage: queue:cutover --stopped [--quarantine-active]");
  console.log(
    JSON.stringify(
      await cutoverLegacyQueues({
        stopped: args.includes("--stopped"),
        quarantineActive: args.includes("--quarantine-active"),
      }),
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cutover failed");
  process.exitCode = 1;
} finally {
  await closeQueueClient();
  await closeQueueDatabase();
  await client.end();
}
