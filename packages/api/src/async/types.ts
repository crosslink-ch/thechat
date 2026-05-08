export type QueueName = string;

export interface AsyncAggregate {
  type: string;
  id: string;
}

export interface AsyncActor {
  type: "user" | "bot" | "system" | "worker";
  id: string;
}

export interface AsyncTenant {
  workspaceId?: string;
  userId?: string;
}

export interface AsyncMessage<TPayload = unknown> {
  id: string;
  type: string;
  version: number;
  aggregate: AsyncAggregate;
  actor?: AsyncActor;
  tenant?: AsyncTenant;
  correlationId: string;
  causationId?: string;
  idempotencyKey?: string;
  occurredAt: string;
  payload: TPayload;
}

export interface AsyncBackoffOptions {
  type: "fixed" | "exponential";
  delay: number;
}

export interface QueueCommand<TPayload = unknown> {
  queue: QueueName;
  name: string;
  message: AsyncMessage<TPayload>;
  jobId: string;
  attempts?: number;
  backoff?: AsyncBackoffOptions;
  delayMs?: number;
  removeOnComplete?: boolean | number;
  removeOnFail?: boolean | number;
}

export interface QueuedJob {
  queue: QueueName;
  name: string;
  bullmqJobId: string;
  messageId: string;
}

export interface AsyncBus {
  enqueue<TPayload>(command: QueueCommand<TPayload>): Promise<QueuedJob>;
  close?(): Promise<void>;
}

export interface AsyncJob<TPayload = unknown> {
  queue: QueueName;
  name: string;
  bullmqJobId: string;
  message: AsyncMessage<TPayload>;
  attemptsMade: number;
  maxAttempts: number;
}

export interface AsyncJobContext {
  setProgress(progress: number, detail?: unknown): Promise<void>;
}

export interface AsyncJobHandler<TPayload = unknown> {
  queue: QueueName;
  name: string;
  handle(job: AsyncJob<TPayload>, context: AsyncJobContext): Promise<unknown>;
}
