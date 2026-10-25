/**
 * Operator CLI for the domain-event dead-letter queue.
 *
 * Events that exhausted their attempts (or failed permanently) keep `dead_at`
 * set in `event_outbox`. They are never pruned and never processed again until
 * replayed here. Replay resets the attempt budget; the worker then processes
 * the row in its original partition order.
 *
 *   bun run dist/scripts/outbox-dlq.js count
 *   bun run dist/scripts/outbox-dlq.js list [--type <event-type>] [--limit <n>]
 *   bun run dist/scripts/outbox-dlq.js show <id>
 *   bun run dist/scripts/outbox-dlq.js replay <id> [<id> ...]
 *   bun run dist/scripts/outbox-dlq.js replay --type <event-type> --all
 */
import {
  countDeadOutboxEvents,
  getDeadOutboxEvent,
  listDeadOutboxEvents,
  replayDeadOutboxEvents,
} from "../events/outbox";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runOutboxDlqCommand(
  argv: string[],
  out: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const [command, ...rest] = argv;
  const { flags, positionals } = parseArgs(rest);

  switch (command) {
    case "count": {
      out(JSON.stringify({ dead: await countDeadOutboxEvents() }));
      return 0;
    }
    case "list": {
      const limit = flags.limit ? Number.parseInt(flags.limit, 10) : 50;
      if (!Number.isInteger(limit) || limit <= 0) return usage(out, "--limit must be a positive integer");
      const rows = await listDeadOutboxEvents({ eventType: flags.type, limit });
      for (const row of rows) {
        out(
          JSON.stringify({
            id: row.id,
            eventType: row.eventType,
            eventVersion: row.eventVersion,
            aggregate: `${row.aggregateType}:${row.aggregateId}`,
            partitionKey: row.partitionKey,
            attempts: row.attempts,
            createdAt: row.createdAt.toISOString(),
            deadAt: row.deadAt.toISOString(),
            lastError: row.lastError,
          }),
        );
      }
      return 0;
    }
    case "show": {
      const [id] = positionals;
      if (!id || !UUID.test(id)) return usage(out, "show needs one event ID");
      const row = await getDeadOutboxEvent(id);
      if (!row) {
        out(JSON.stringify({ error: "not_found", id }));
        return 1;
      }
      out(JSON.stringify(row, null, 2));
      return 0;
    }
    case "replay": {
      if (positionals.length > 0) {
        const invalid = positionals.find((id) => !UUID.test(id));
        if (invalid) return usage(out, `not an event ID: ${invalid}`);
        const replayed = await replayDeadOutboxEvents({ ids: positionals });
        const missing = positionals.filter((id) => !replayed.includes(id));
        out(JSON.stringify({ replayed, notDead: missing }));
        return missing.length > 0 ? 1 : 0;
      }
      if (flags.type && flags.all === "true") {
        const replayed = await replayDeadOutboxEvents({ eventType: flags.type });
        out(JSON.stringify({ replayed }));
        return 0;
      }
      return usage(out, "replay needs event IDs, or --type <event-type> --all");
    }
    default:
      return usage(out, command ? `unknown command: ${command}` : undefined);
  }
}

function parseArgs(args: string[]) {
  const flags: Record<string, string | undefined> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "all") {
      flags.all = "true";
      continue;
    }
    flags[name] = args[index + 1];
    index += 1;
  }
  return { flags, positionals };
}

function usage(out: (line: string) => void, problem?: string) {
  if (problem) out(`error: ${problem}`);
  out(
    [
      "usage:",
      "  outbox-dlq count",
      "  outbox-dlq list [--type <event-type>] [--limit <n>]",
      "  outbox-dlq show <id>",
      "  outbox-dlq replay <id> [<id> ...]",
      "  outbox-dlq replay --type <event-type> --all",
    ].join("\n"),
  );
  return 2;
}

if (import.meta.main) {
  runOutboxDlqCommand(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
