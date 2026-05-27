#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

loadEnvFile(path.join(process.cwd(), ".env"));
loadEnvFile(path.join(os.homedir(), ".hermes", ".env"));
loadEnvFile(path.join(process.cwd(), ".env.local"));

const args = parseArgs(process.argv.slice(2));

if (hasFlag("help") || hasFlag("h")) {
  printHelp();
  process.exit(0);
}

const baseUrl = trimTrailingSlash(
  args["base-url"] ||
    process.env.THECHAT_BASE_URL ||
    process.env.THECHAT_BACKEND_URL ||
    "http://localhost:3337",
);
const botToken =
  args["bot-token"] ||
  process.env.THECHAT_BOT_TOKEN ||
  process.env.THECHAT_HERMES_BOT_TOKEN;
const scenario = String(args.scenario || args.mode || "single").toLowerCase();
const defaultCount = scenario === "parallel" ? 2 : 1;
const claimCount = parsePositiveInt(args.count || args["claim-count"], defaultCount);
const holdMs = parseNonNegativeInt(args["hold-ms"], 1200);
const waitMs = parseNonNegativeInt(args["wait-ms"], 60000);
const pollMs = parseNonNegativeInt(args["poll-ms"], 750);
const webhookHost = args["webhook-host"] || "127.0.0.1";
const webhookPort = parseNonNegativeInt(args["webhook-port"], 0);
const webhookPath = args["webhook-path"] || "/thechat-progress-demo";
const keepWebhook = hasFlag("keep-webhook");
const shouldComplete = !hasFlag("no-complete");
const shouldPostCron = hasFlag("cron") || scenario === "cron";
const cronCount = parsePositiveInt(args["cron-count"], shouldPostCron ? 1 : 0);

if (!botToken) {
  fail("Missing bot token. Set THECHAT_BOT_TOKEN or pass --bot-token=bot_...");
}

if (!["single", "parallel", "cron"].includes(scenario)) {
  fail(`Unsupported scenario "${scenario}". Use single, parallel, or cron.`);
}

console.log(`Using TheChat API at ${baseUrl}`);
await request("/hermes-platform/health", { method: "GET" });

if (scenario === "cron") {
  await postCronMessages(targetFromArgs(), cronCount, "explicit");
  process.exit(0);
}

const outcomes = parseOutcomes(args.outcomes, claimCount, shouldComplete);
const { events, cleanup } = await claimOrReceiveInvocations(claimCount);

try {
  describeClaimedEvents(events);
  await runInvocationScenario(events, outcomes);

  if (shouldPostCron) {
    await sleep(holdMs);
    for (let index = 0; index < events.length; index += 1) {
      await postCronMessages(targetFromEvent(events[index]), cronCount, `event ${index + 1}`);
    }
  }
} finally {
  await cleanup();
}

async function runInvocationScenario(events, outcomes) {
  await emitProgressRound(events, (event, index) => ({
    type: "reasoning.available",
    status: "running",
    preview: formatTemplate(
      args.preview ||
        "Demo task {index}: planning a response for thread {threadIdOrNone}.",
      event,
      index,
    ),
    payload: {
      text: formatTemplate(
        args.preview ||
          "Demo task {index}: planning a response for thread {threadIdOrNone}.",
        event,
        index,
      ),
      chatId: event.chatId,
      threadId: event.threadId ?? null,
    },
  }));
  await sleep(holdMs);

  await emitProgressRound(events, (event, index) => ({
    type: "tool.started",
    status: "running",
    toolCallId: `demo-${index + 1}-read`,
    toolName: "read_file",
    label: formatTemplate(
      args["tool-label"] || "Read task context for demo task {index}",
      event,
      index,
    ),
    payload: {
      args: {
        path: "packages/api/src/services/bot-runtime.ts",
      },
    },
  }));
  await sleep(holdMs);

  await emitProgressRound(events, (_event, index) => ({
    type: "tool.completed",
    status: "completed",
    toolCallId: `demo-${index + 1}-read`,
    toolName: "read_file",
    payload: {
      duration: 1.2 + index / 10,
      isError: false,
    },
  }));
  await sleep(holdMs);

  await emitProgressRound(events, (event, index) => ({
    type: "tool.started",
    status: "running",
    toolCallId: `demo-${index + 1}-shell`,
    toolName: "shell",
    label: formatTemplate(
      args["shell-label"] || "Shell: simulate Hermes work for task {index}",
      event,
      index,
    ),
    payload: {
      args: {
        command: "pnpm test:api",
      },
    },
  }));
  await sleep(holdMs);

  await emitProgressRound(events, (_event, index) => ({
    type: "tool.completed",
    status: "completed",
    toolCallId: `demo-${index + 1}-shell`,
    toolName: "shell",
    payload: {
      duration: 2.4 + index / 10,
      isError: false,
    },
  }));

  for (let index = 0; index < events.length; index += 1) {
    await sleep(holdMs);
    await finishInvocation(events[index], outcomes[index], index);
  }
}

async function emitProgressRound(events, bodyForEvent) {
  for (let index = 0; index < events.length; index += 1) {
    await emitProgress(events[index].invocationId, bodyForEvent(events[index], index));
  }
}

async function emitProgress(invocationId, body) {
  await request(`/hermes-platform/invocations/${invocationId}/progress`, {
    method: "POST",
    body,
  });
  console.log(
    `Sent ${body.type} to ${shortId(invocationId)}${
      body.toolName ? ` for ${body.toolName}` : ""
    }`,
  );
}

async function finishInvocation(event, outcome, index) {
  if (outcome === "running") {
    console.log(`Left invocation ${shortId(event.invocationId)} running.`);
    return;
  }

  if (outcome === "message-only" || outcome === "partial") {
    await postInvocationMessage(event, index, {
      content:
        args["partial-response"] ||
        "Demo partial response for task {index}. The invocation is intentionally still running.",
      complete: false,
    });
    console.log(`Posted non-final message for ${shortId(event.invocationId)}.`);
    return;
  }

  if (outcome === "fail" || outcome === "failed") {
    await request(`/hermes-platform/invocations/${event.invocationId}/failed`, {
      method: "POST",
      body: {
        error: formatTemplate(
          args["fail-error"] || "Synthetic Hermes demo failure for task {index}",
          event,
          index,
        ),
      },
    });
    console.log(`Failed invocation ${shortId(event.invocationId)}.`);
    return;
  }

  if (outcome === "cancel" || outcome === "cancelled") {
    await request(`/hermes-platform/invocations/${event.invocationId}/cancelled`, {
      method: "POST",
      body: {
        reason: formatTemplate(
          args["cancel-reason"] || "Synthetic Hermes demo cancellation for task {index}",
          event,
          index,
        ),
      },
    });
    console.log(`Cancelled invocation ${shortId(event.invocationId)}.`);
    return;
  }

  if (outcome !== "complete" && outcome !== "completed") {
    fail(`Unsupported outcome "${outcome}".`);
  }

  await postInvocationMessage(event, index, {
    content:
      args.response ||
      "Hermes simulator response for task {index}. This was generated by scripts/hermes-progress-demo.mjs, not by an AI model.",
    complete: false,
  });
  await request(`/hermes-platform/invocations/${event.invocationId}/completed`, {
    method: "POST",
    body: {
      reason: formatTemplate(
        args["complete-reason"] || "Hermes progress demo completed task {index}",
        event,
        index,
      ),
    },
  });
  console.log(`Completed invocation ${shortId(event.invocationId)} with a demo response.`);
}

async function postInvocationMessage(event, index, options) {
  await request("/hermes-platform/messages", {
    method: "POST",
    body: {
      invocationId: event.invocationId,
      content: formatTemplate(options.content, event, index),
      platformMessageId: platformMessageId("response", event, index),
      complete: options.complete,
    },
  });
}

async function postCronMessages(target, count, label) {
  for (let index = 0; index < count; index += 1) {
    const content = formatTemplate(
      args["cron-content"] ||
        "Scheduled Hermes demo update for task {index}. This simulates a cron/proactive message without a live Hermes gateway.",
      target.event,
      index,
      target,
    );
    const body = {
      ...(target.conversationId ? { conversationId: target.conversationId } : {}),
      ...(target.chatId ? { chatId: target.chatId } : {}),
      ...(target.threadId ? { threadId: target.threadId } : {}),
      content,
      platformMessageId: platformMessageId("cron", target.event, index, target),
    };
    await request("/hermes-platform/messages", {
      method: "POST",
      body,
    });
    console.log(
      `Posted cron-style message for ${label}: chat=${target.chatId || target.conversationId}${
        target.threadId ? ` thread=${target.threadId}` : ""
      }`,
    );
    if (index + 1 < count) await sleep(holdMs);
  }
}

async function claimOrReceiveInvocations(targetCount) {
  const events = [];
  const seen = new Set();

  async function claimQueued() {
    const missing = targetCount - events.length;
    if (missing <= 0) return;
    const claimed = await request(`/hermes-platform/events?limit=${missing}`, {
      method: "GET",
    });
    addEvents(claimed.events || [], events, seen);
  }

  console.log(`Checking for ${targetCount} queued Hermes invocation(s)...`);
  await claimQueued();
  if (events.length >= targetCount) {
    return { events, cleanup: async () => {} };
  }

  console.log(`Waiting for ${targetCount - events.length} more invocation(s).`);
  console.log("Starting a temporary webhook receiver for webhook-mode bots...");
  const receiver = await startWebhookReceiver();
  const webhookUrl = `http://${webhookHost}:${receiver.port}${webhookPath}`;
  await request("/bots/me/webhook", {
    method: "POST",
    body: { url: webhookUrl },
  });
  console.log(`Temporary webhook registered at ${webhookUrl}`);
  console.log(
    `Now send ${targetCount - events.length} message(s) to the Hermes bot in TheChat.`,
  );

  const cleanup = async () => {
    receiver.close();
    if (keepWebhook) return;
    try {
      await request("/bots/me/webhook", { method: "DELETE" });
      console.log("Cleared the temporary webhook registration.");
    } catch (error) {
      console.warn("Failed to clear temporary webhook registration:", error.message);
    }
  };

  try {
    await withTimeout(
      waitForEvents({
        events,
        seen,
        targetCount,
        receiver,
        claimQueued,
      }),
      waitMs,
      `Timed out waiting for ${targetCount} Hermes invocation(s) after ${waitMs}ms. Make sure TheChat API is running, then send new messages to the Hermes bot.`,
    );
    return { events, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function waitForEvents({ events, seen, targetCount, receiver, claimQueued }) {
  while (events.length < targetCount) {
    addEvents(receiver.drain(), events, seen);
    if (events.length >= targetCount) break;
    await claimQueued();
    if (events.length >= targetCount) break;
    await sleep(pollMs);
  }
}

function addEvents(incoming, events, seen) {
  for (const event of incoming) {
    if (!event?.invocationId || seen.has(event.invocationId)) continue;
    seen.add(event.invocationId);
    events.push(event);
    console.log(
      `Claimed invocation ${shortId(event.invocationId)} chat=${event.chatId}${
        event.threadId ? ` thread=${event.threadId}` : ""
      }`,
    );
  }
}

async function startWebhookReceiver() {
  const queue = [];
  let closed = false;

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== webhookPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      const raw = await readRequestBody(req);
      const payload = JSON.parse(raw || "{}");
      const events = eventsFromWebhookPayload(payload);
      for (const event of events) queue.push(event);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(webhookPort, webhookHost, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : webhookPort;
  return {
    port,
    drain() {
      return queue.splice(0, queue.length);
    },
    close() {
      if (closed) return;
      closed = true;
      server.close();
    },
  };
}

function eventsFromWebhookPayload(payload) {
  const events = Array.isArray(payload.events)
    ? payload.events
    : [payload.event && typeof payload.event === "object" ? payload.event : payload];
  for (const event of events) {
    if (!event?.invocationId) throw new Error("Webhook payload missing invocationId");
  }
  return events;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function request(endpoint, options) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${botToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const body = parseJsonResponse(text);
  if (!response.ok) {
    throw new Error(
      `${options.method} ${endpoint} failed with HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function targetFromArgs() {
  const conversationId = args["conversation-id"] || "";
  const chatId = args["chat-id"] || conversationId;
  const threadId = args["thread-id"] || "";
  if (!chatId && !conversationId) {
    fail("Cron scenario requires --chat-id=<conversationId> or --conversation-id=<conversationId>.");
  }
  return {
    chatId,
    conversationId,
    threadId: threadId || null,
    event: null,
  };
}

function targetFromEvent(event) {
  return {
    chatId: event.chatId,
    conversationId: event.conversation?.id || event.chatId,
    threadId: event.threadId ?? null,
    event,
  };
}

function describeClaimedEvents(events) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    console.log(
      [
        `Task ${index + 1}`,
        `invocation=${event.invocationId}`,
        `chat=${event.chatId}`,
        `thread=${event.threadId || "none"}`,
        `text=${JSON.stringify(event.text || "")}`,
      ].join(" "),
    );
  }
}

function parseOutcomes(raw, count, defaultComplete) {
  const defaults = Array(count).fill(defaultComplete ? "complete" : "running");
  if (!raw) return defaults;
  const values = String(raw)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0) return defaults;
  const allowed = new Set([
    "complete",
    "completed",
    "fail",
    "failed",
    "cancel",
    "cancelled",
    "running",
    "message-only",
    "partial",
  ]);
  for (const value of values) {
    if (!allowed.has(value)) fail(`Unsupported outcome "${value}".`);
  }
  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push(values[index] || values[values.length - 1]);
  }
  return result;
}

function platformMessageId(kind, event, index, explicitTarget) {
  const template = args["platform-message-id"];
  const target = explicitTarget || targetFromEvent(event || {});
  if (template) return formatTemplate(template, event, index, target);
  const threadPart = target.threadId || "no-thread";
  return `hermes-demo-${kind}-${Date.now()}-${threadPart}-${index + 1}`;
}

function formatTemplate(template, event, zeroIndex, explicitTarget) {
  const target = explicitTarget || (event ? targetFromEvent(event) : {});
  const replacements = {
    index: String(zeroIndex + 1),
    zeroIndex: String(zeroIndex),
    invocationId: event?.invocationId || "",
    chatId: target.chatId || "",
    conversationId: target.conversationId || target.chatId || "",
    threadId: target.threadId || "",
    threadIdOrNone: target.threadId || "none",
    text: event?.text || "",
  };
  return String(template).replace(
    /\{(index|zeroIndex|invocationId|chatId|conversationId|threadId|threadIdOrNone|text)\}/g,
    (_match, key) => replacements[key],
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--") continue;
    if (!arg.startsWith("--")) continue;
    const [key, ...valueParts] = arg.slice(2).split("=");
    parsed[key] = valueParts.length > 0 ? valueParts.join("=") : "true";
  }
  return parsed;
}

function hasFlag(name) {
  const value = args[name];
  return value !== undefined && value !== "false" && value !== "0";
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseNonNegativeInt(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(rawValue.trim());
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "");
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function parseJsonResponse(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(ms) ? ms : 0));
}

function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function shortId(value) {
  return String(value || "").slice(0, 8);
}

function printHelp() {
  console.log(`Usage:
  pnpm dev:hermes-progress-demo -- [options]

Scenarios:
  --scenario=single              Claim one invocation, emit progress, complete it. Default.
  --scenario=parallel --count=2  Claim multiple invocations and interleave progress.
  --scenario=cron                Post a proactive cron-style message without an invocation.

Useful options:
  --bot-token=bot_...            Hermes bot token. Also reads THECHAT_BOT_TOKEN.
  --base-url=http://localhost:3337
  --count=2                      Number of invocations to claim for single/parallel.
  --outcomes=complete,fail       Per-invocation outcomes: complete, fail, cancel, running, message-only.
  --cron                         After claimed invocations finish, post cron-style messages into their chats/threads.
  --cron-count=1
  --cron-content="Scheduled update for task {index}"
  --scenario=cron --chat-id=... --thread-id=...
  --hold-ms=1200                 Delay between simulated progress stages.
  --wait-ms=60000                How long to wait for user-created invocations.
  --no-complete                  Leave claimed invocations running unless --outcomes is provided.

Templates may use {index}, {invocationId}, {chatId}, {conversationId}, {threadId}, {threadIdOrNone}, and {text}.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
