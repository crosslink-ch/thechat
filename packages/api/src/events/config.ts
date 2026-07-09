export type DomainEventsDriver = "outbox" | "kafka";

export interface DomainEventsConfig {
  driver: DomainEventsDriver;
  batchSize: number;
  pollIntervalMs: number;
  lockTimeoutMs: number;
  kafka: {
    brokers: string[];
    clientId: string;
    topic: string;
    autoCreateTopics: boolean;
    topicPartitions: number;
    fromBeginning: boolean;
    consumerGroup: string;
    ssl: boolean;
    sasl?: {
      mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
      username: string;
      password: string;
    };
  };
}

export function loadDomainEventsConfig(
  env: NodeJS.ProcessEnv = process.env,
): DomainEventsConfig {
  const driver = (env.DOMAIN_EVENTS_DRIVER?.trim() || "outbox") as
    | DomainEventsDriver
    | string;
  if (driver !== "outbox" && driver !== "kafka") {
    throw new Error(
      `DOMAIN_EVENTS_DRIVER must be "outbox" or "kafka"; received ${driver}`,
    );
  }

  const brokers = (env.KAFKA_BROKERS ?? "")
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean);
  if (driver === "kafka" && brokers.length === 0) {
    throw new Error(
      "KAFKA_BROKERS is required when DOMAIN_EVENTS_DRIVER=kafka",
    );
  }

  return {
    driver,
    batchSize: positiveInteger(env.DOMAIN_EVENTS_BATCH_SIZE, 50),
    pollIntervalMs: positiveInteger(env.DOMAIN_EVENTS_POLL_INTERVAL_MS, 500),
    lockTimeoutMs: positiveInteger(
      env.DOMAIN_EVENTS_LOCK_TIMEOUT_MS,
      60_000,
    ),
    kafka: {
      brokers,
      clientId: env.KAFKA_CLIENT_ID?.trim() || "thechat-worker",
      topic: env.KAFKA_TOPIC?.trim() || "thechat.domain-events.v1",
      autoCreateTopics: booleanValue(env.KAFKA_AUTO_CREATE_TOPICS),
      topicPartitions: positiveInteger(env.KAFKA_TOPIC_PARTITIONS, 3),
      fromBeginning: booleanValue(env.KAFKA_FROM_BEGINNING, true),
      consumerGroup:
        env.KAFKA_CONSUMER_GROUP?.trim() ||
        "thechat-message-events-v1",
      ssl: booleanValue(env.KAFKA_SSL),
      sasl: driver === "kafka" ? saslConfig(env) : undefined,
    },
  };
}

function saslConfig(
  env: NodeJS.ProcessEnv,
): DomainEventsConfig["kafka"]["sasl"] {
  const rawMechanism = env.KAFKA_SASL_MECHANISM?.trim().toLowerCase();
  if (!rawMechanism) return undefined;
  if (
    rawMechanism !== "plain" &&
    rawMechanism !== "scram-sha-256" &&
    rawMechanism !== "scram-sha-512"
  ) {
    throw new Error(
      "KAFKA_SASL_MECHANISM must be plain, scram-sha-256, or scram-sha-512",
    );
  }

  const username = env.KAFKA_SASL_USERNAME?.trim();
  const password = env.KAFKA_SASL_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are required when KAFKA_SASL_MECHANISM is set",
    );
  }

  return { mechanism: rawMechanism, username, password };
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback = false) {
  if (value === undefined || value.trim() === "") return fallback;
  return value === "1" || value?.toLowerCase() === "true";
}
