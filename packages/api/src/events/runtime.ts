import { SpanKind } from "@opentelemetry/api";
import type { PgBoss } from "pg-boss";
import {
  createQueueClient,
  QUEUES,
  queueConfig,
  archiveFailedJobs,
  observeDeadLetters,
} from "../async/queue";
import { contextFromTraceContext, withSpan } from "../observability";
import { log } from "../logging";
import { createChatMessageSentHandler } from "./message-handler";
import { createBotRequestAnsweredHandler } from "../bot-requests/delivery";
import {
  createAttachmentDeletionHandler,
  createAttachmentValidationHandler,
} from "../attachments/handler";
import {
  DomainEventRegistry,
  InvalidDomainEventError,
  PermanentDomainEventError,
} from "./registry";
import type { DomainEventEnvelope } from "./envelope";
import type { DomainEventsConfig } from "./config";

export interface DomainEventRuntimeOptions {
  config?: Partial<DomainEventsConfig>;
  registry?: DomainEventRegistry;
  workerId?: string;
}
export function createDefaultDomainEventRegistry() {
  return new DomainEventRegistry()
    .register(createChatMessageSentHandler())
    .register(createAttachmentValidationHandler())
    .register(createAttachmentDeletionHandler())
    .register(createBotRequestAnsweredHandler());
}
export async function consumeDomainJob(
  job: {
    id: string;
    name: string;
    data: unknown;
    retryCount: number;
    signal: AbortSignal;
  },
  registry: DomainEventRegistry,
) {
  const data = job.data as DomainEventEnvelope | null;
  try {
    await withSpan(
      "domain_event.consume",
      {
        "messaging.system": "pg-boss",
        "messaging.destination.name": job.name,
        "thechat.queue.attempt": job.retryCount + 1,
      },
      () =>
        registry.dispatch(job.data, {
          rejectMissing: true,
          signal: job.signal,
        }),
      {
        kind: SpanKind.CONSUMER,
        parentContext: contextFromTraceContext(data?.traceContext),
      },
    );
    return [{ id: job.id, status: "completed" as const }];
  } catch (error) {
    const permanent =
      error instanceof InvalidDomainEventError ||
      error instanceof PermanentDomainEventError;
    const errorType =
      error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)
        ? error.name
        : "Error";
    log.warn(
      {
        component: "pg-boss",
        queue: job.name,
        jobId: job.id,
        attempt: job.retryCount + 1,
        errorType,
      },
      "Domain job failed",
    );
    return [
      {
        id: job.id,
        status: permanent ? ("deadletter" as const) : ("failed" as const),
        output: { errorType },
      },
    ];
  }
}
export class DomainEventRuntime {
  private boss: PgBoss | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private archive: Promise<unknown> | undefined;
  private stopMetrics: (() => void) | undefined;
  constructor(private options: DomainEventRuntimeOptions = {}) {}
  async start() {
    if (this.boss) return;
    const boss = createQueueClient({ worker: true });
    await boss.start();
    this.boss = boss;
    this.stopMetrics = observeDeadLetters();
    const registry =
      this.options.registry ?? createDefaultDomainEventRegistry();
    await archiveFailedJobs();
    for (const name of [QUEUES.chat, QUEUES.attachments, QUEUES.answers]) {
      await boss.work<
        DomainEventEnvelope,
        never,
        {
          includeMetadata: true;
          perJobResults: true;
          batchSize: number;
          localConcurrency: number;
          pollingIntervalSeconds: number;
        }
      >(
        name,
        {
          includeMetadata: true,
          perJobResults: true,
          batchSize: 1,
          localConcurrency:
            name === QUEUES.attachments
              ? (this.options.config?.attachmentConcurrency ??
                queueConfig.concurrency[name])
              : (this.options.config?.batchSize ??
                queueConfig.concurrency[name]),
          pollingIntervalSeconds: queueConfig.pollingIntervalSeconds,
        },
        async ([job]) => consumeDomainJob(job, registry),
      );
    }
    this.timer = setInterval(() => {
      if (!this.archive)
        this.archive = archiveFailedJobs()
          .catch(() =>
            log.error({ component: "pg-boss" }, "Dead-letter archival failed"),
          )
          .finally(() => {
            this.archive = undefined;
          });
    }, 1000);
  }
  async close() {
    clearInterval(this.timer);
    this.stopMetrics?.();
    this.stopMetrics = undefined;
    const boss = this.boss;
    this.boss = undefined;
    await boss?.stop({
      graceful: true,
      timeout:
        this.options.config?.shutdownGraceMs ?? queueConfig.shutdownTimeoutMs,
    });
    await this.archive;
    await archiveFailedJobs();
  }
}
let runtime: DomainEventRuntime | null = null;
let starting: Promise<DomainEventRuntime> | null = null;
export function startDomainEventRuntime(
  options: DomainEventRuntimeOptions = {},
) {
  return (starting ??= (async () => {
    const r = new DomainEventRuntime(options);
    await r.start();
    runtime = r;
    return r;
  })().catch((e) => {
    starting = null;
    throw e;
  }));
}
export async function closeDomainEventRuntime() {
  const r = runtime;
  runtime = null;
  starting = null;
  await r?.close();
}
