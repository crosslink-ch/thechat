/** Explicit, destructive ONLY to a newly created loopback test database.
 * pnpm --filter @thechat/api queue:smoke
 * Requires THECHAT_QUEUE_SMOKE_ALLOW_DATABASE_CREATE=1 and a CREATEDB test role.
 * Never points runtime processes at the source database.
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

assert.equal(
  process.env.THECHAT_QUEUE_SMOKE_ALLOW_DATABASE_CREATE,
  "1",
  "Explicit test-database creation opt-in required",
);
const sourceUrl = new URL(process.env.DATABASE_URL!);
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(sourceUrl.hostname),
  "Loopback PostgreSQL only",
);
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:16380");
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(redisUrl.hostname),
  "Loopback Redis only",
);
const databaseName = `queue_smoke_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
const admin = postgres(sourceUrl.toString(), { max: 1 });
const cwd = fileURLToPath(new URL("../../", import.meta.url));
const children: ReturnType<typeof Bun.spawn>[] = [];
const documents: { path: string; body: any }[] = [];
const collector = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    documents.push({
      path: new URL(request.url).pathname,
      body: await request.json(),
    });
    return Response.json({});
  },
});
const endpoint = `http://127.0.0.1:${collector.port}`;
const env = {
  ...process.env,
  DATABASE_URL: testUrl.toString(),
  REDIS_KEY_PREFIX: databaseName,
  THECHAT_OTEL_ENABLED: "true",
  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${endpoint}/v1/metrics`,
  BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  NODE_ENV: "test",
  THECHAT_BACKEND_HOST: "127.0.0.1",
};
Object.assign(process.env, env);
async function until(
  check: () => Promise<boolean> | boolean,
  label: string,
  ms = 45_000,
) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw Error(`Timed out: ${label}`);
}
async function command(args: string[], expected = 0) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, expected, `${args.join(" ")}\n${out}\n${err}`);
    return out + err;
  } finally {
    clearTimeout(timer);
  }
}
const spans = () =>
  documents
    .flatMap((d) => d.body.resourceSpans ?? [])
    .flatMap((r) => r.scopeSpans ?? [])
    .flatMap((s) => s.spans ?? []);
const metrics = () =>
  documents
    .flatMap((d) => d.body.resourceMetrics ?? [])
    .flatMap((r) => r.scopeMetrics ?? [])
    .flatMap((s) => s.metrics ?? []);
let dbModule: typeof import("../db") | undefined;
let queues: typeof import("./queue") | undefined;
let observability: typeof import("../observability") | undefined;
let created = false;
try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await command(["pnpm", "build"]);
  await command(["pnpm", "db:migrate"]);
  const bootFailure = await command(
    [process.execPath, "dist/scripts/worker.js"],
    1,
  );
  assert.ok(
    bootFailure.includes("queue:setup"),
    "Missing-schema startup must fail closed with operator guidance",
  );
  await command([process.execPath, "dist/scripts/queue-setup.js"]);
  await command([process.execPath, "dist/scripts/queue-setup.js"]);
  console.log(
    "PASS fresh Drizzle migrations, fail-closed startup and idempotent compiled queue setup",
  );

  dbModule = await import("../db");
  queues = await import("./queue");
  observability = await import("../observability");
  const { sql } = await import("drizzle-orm");
  const { enqueueDomainEvent } = await import("../events/outbox");
  const { createChatMessageSentV1 } = await import("../events/envelope");
  const { db } = dbModule;
  await observability.initObservability("thechat-queue-smoke-producer");
  const boss = await queues.getQueueClient();
  const user = crypto.randomUUID(),
    conversation = crypto.randomUUID(),
    message = crypto.randomUUID();
  const sensitive = `smoke-private-content-${crypto.randomUUID()}`;
  const event = createChatMessageSentV1({
    messageId: message,
    conversationId: conversation,
    senderId: user,
    senderType: "human",
    targetBotIds: [],
    messageKind: "user",
    automationDepth: 0,
  });
  let traceId = "";
  await observability.withSpan("queue.smoke.publish", {}, async (span) => {
    traceId = span.spanContext().traceId;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`insert into users(id,name) values(${user},'Queue smoke')`,
      );
      await tx.execute(
        sql`insert into conversations(id,type) values(${conversation},'direct')`,
      );
      await tx.execute(
        sql`insert into messages(id,conversation_id,sender_id,content) values(${message},${conversation},${user},${sensitive})`,
      );
      await enqueueDomainEvent(tx, event, { partitionKey: conversation });
    });
  });
  const poisonId = crypto.randomUUID();
  await boss.send(
    queues.QUEUES.chat,
    { sensitive },
    { id: poisonId, singletonKey: poisonId },
  );
  const worker = Bun.spawn([process.execPath, "dist/scripts/worker.js"], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(worker);
  const workerOut = new Response(worker.stdout).text(),
    workerErr = new Response(worker.stderr).text();
  await until(
    async () =>
      (await boss.findJobs(queues!.QUEUES.chat, { id: event.id }))[0]?.state ===
      "completed",
    "compiled chat consumer",
  );
  await until(
    async () =>
      (
        await db.execute(
          sql`select id from queue_dead_letters where id=${poisonId}`,
        )
      ).length === 1,
    "compiled DLQ archival",
  );
  const list = JSON.parse(
    await command([process.execPath, "dist/scripts/outbox-dlq.js", "list"]),
  );
  assert.ok(list.some((row: { id: string }) => row.id === poisonId));
  console.log(
    "PASS compiled worker consumed a transactional message; poison archived; compiled DLQ list",
  );

  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  await probe.stop(true);
  const api = Bun.spawn([process.execPath, "dist/index.js"], {
    cwd,
    env: { ...env, THECHAT_BACKEND_PORT: String(port) },
    stdout: "ignore",
    stderr: "pipe",
  });
  children.push(api);
  const apiErr = new Response(api.stderr).text();
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).status === 200;
    } catch {
      return false;
    }
  }, "compiled API health");
  console.log("PASS compiled API health on fresh schema");
  await until(
    () =>
      metrics().some((m) => m.name === "thechat.queue.dead_letters") &&
      metrics().some((m) => m.name.includes("queue")) &&
      spans().some(
        (s) => s.name === "domain_event.consume" && s.traceId === traceId,
      ),
    "real OTLP metrics and cross-process trace",
  );
  const names = [...new Set(metrics().map((m) => m.name))].sort();
  for (const name of [
    "pgboss.queue.jobs",
    "thechat.queue.dead_letters",
    "thechat.queue.oldest_ready_age",
  ])
    assert.ok(names.includes(name), `Missing metric: ${name}`);
  assert.ok(
    metrics()
      .filter((m) => m.name === "thechat.queue.dead_letters")
      .flatMap((m) => m.gauge?.dataPoints ?? [])
      .some((p) => Number(p.asInt ?? p.asDouble) === 1),
    "Live DLQ count exported",
  );
  assert.ok(
    names.some((name) => name.includes("consumed")),
    "Native pg-boss consumption metric exported",
  );
  assert.ok(
    !JSON.stringify(documents).includes(sensitive),
    "Telemetry leaked payload content",
  );
  const [connections] = await db.execute(
    sql`select count(*)::int as count from pg_stat_activity where datname=${databaseName} and application_name='thechat-pgboss'`,
  );
  assert.ok(
    Number(connections.count) <= 6,
    "Queue pools exceed two connections per process",
  );
  console.log(
    "PASS real OTLP export, trace propagation, payload redaction and bounded queue pools",
    JSON.stringify(names),
  );
  const start = Date.now();
  worker.kill("SIGTERM");
  await until(() => worker.exitCode !== null, "worker SIGTERM", 40_000);
  assert.equal(await worker.exited, 0, (await workerOut) + (await workerErr));
  const [live] = await db.execute(
    sql`select count(*)::int as count from pgboss.instance where stopped_on is null`,
  );
  assert.equal(Number(live.count), 0, "Worker instances must be deregistered");
  console.log(
    `PASS compiled worker SIGTERM and deregistration (${Date.now() - start}ms)`,
  );
  api.kill("SIGTERM");
  await until(() => api.exitCode !== null, "API SIGTERM", 40_000);
  await apiErr;
  console.log("QUEUE_SMOKE_PASS");
} finally {
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(children.map((child) => child.exited));
  await observability?.shutdownObservability();
  await queues?.closeQueueClient();
  await queues?.closeQueueDatabase();
  await dbModule?.client.end();
  await collector.stop(true);
  if (created)
    await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
