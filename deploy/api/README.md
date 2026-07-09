# thechat-api Helm Chart

Deploys the TheChat API server and bot worker to Kubernetes.

## Prerequisites

- Kubernetes 1.24+
- Helm 3+
- An external PostgreSQL database
- An external Redis instance for realtime fanout and BullMQ workers
- For Kafka mode only, an external managed or operator-backed Kafka cluster
- Secrets pre-created in the target namespace (see below)

## Secrets

The chart references existing Kubernetes secrets by name — it does not create them. Create them before installing:

```bash
# Required
kubectl create secret generic thechat-db --from-literal=DATABASE_URL='postgresql://user:pass@host:5432/thechat'
kubectl create secret generic thechat-jwt --from-literal=JWT_SECRET='your-jwt-secret'
kubectl create secret generic thechat-redis --from-literal=REDIS_URL='redis://redis-host:6379'

# Optional — SMTP credentials
kubectl create secret generic thechat-smtp \
  --from-literal=SMTP_HOST='smtp.example.com' \
  --from-literal=SMTP_PORT='587' \
  --from-literal=SMTP_USER='user' \
  --from-literal=SMTP_PASS='pass'

# Optional — Postmark (alternative to SMTP)
kubectl create secret generic thechat-postmark --from-literal=POSTMARK_API_TOKEN='your-token'
```

Kafka is optional because the chart defaults to
`env.DOMAIN_EVENTS_DRIVER=outbox`. To relay domain events through an external
Kafka cluster, create broker and optional SASL secrets:

```bash
kubectl create secret generic thechat-kafka \
  --from-literal=KAFKA_BROKERS='broker-0:9093,broker-1:9093'

kubectl create secret generic thechat-kafka-sasl \
  --from-literal=KAFKA_SASL_MECHANISM='scram-sha-512' \
  --from-literal=KAFKA_SASL_USERNAME='thechat' \
  --from-literal=KAFKA_SASL_PASSWORD='replace-me'
```

Then set:

```yaml
env:
  DOMAIN_EVENTS_DRIVER: kafka
  KAFKA_SSL: "true"
  KAFKA_AUTO_CREATE_TOPICS: "false"
kafka:
  existingSecret: thechat-kafka
  saslSecret: thechat-kafka-sasl
```

For brokers that do not require a secret, use `kafka.brokers` instead. The
chart fails rendering when Kafka mode has neither `kafka.brokers` nor
`kafka.existingSecret`, and it does not deploy a Kafka broker. Production Kafka
should be multi-broker, with both `thechat.domain-events.v1` and
`thechat.domain-events.v1.dlq` pre-created, partitioned for expected conversation
concurrency, replicated, retained, secured, and monitored.

## Migrations

Database migrations run automatically via an init container before the API starts. The init container uses a separate image (`thechat-api-migrate`) that contains `drizzle-kit` and the migration files from `packages/api/drizzle/`.

Migration files must be generated and committed to git before building the image:

```bash
cd packages/api
pnpm db:generate   # generates SQL migration files in drizzle/
```

Run this whenever you change `src/db/schema.ts`, then commit the resulting files in `drizzle/`.

## Worker

The API Deployment only serves HTTP traffic. Bot jobs are consumed by a separate
worker Deployment controlled by `worker.enabled` in `values.yaml`. The worker
uses the same API image and runs `bun run dist/scripts/worker.js`.
It also claims the transactional domain-event outbox. In `outbox` mode it
handles events directly; in `kafka` mode it publishes to Kafka and consumes via
the configured consumer group. Delivery is at least once, so handlers must be
idempotent; TheChat uses the unique bot/trigger-message invocation key and
stable target IDs captured in each event.

The event runtime is supervised with the BullMQ worker: an unrecoverable Kafka
consumer crash fails the process so Kubernetes restarts it instead of leaving a
silent relay-only pod. BullMQ jobs remain durable in Redis and resume after the
restart, but bot-job and domain-event availability share this worker failure
domain. Split them into separate Deployments if they need independent SLOs.

The worker Deployment uses `Recreate`, intentionally preventing old outbox-mode
and new Kafka-mode workers from overlapping during a driver cutover. Before
switching to Kafka, apply migrations, pre-create the main and DLQ topics, verify
worker credentials/ACLs, and render the chart with production values. Roll back
by restoring `DOMAIN_EVENTS_DRIVER=outbox`; pending, unpublished rows remain in
PostgreSQL. Alert on worker restarts, consumer lag, DLQ traffic,
`event_outbox.dead_at`, and old unpublished outbox rows. Reset a reviewed
PostgreSQL quarantine row by clearing `dead_at`, `locked_at`, and `locked_by`,
resetting `attempts`, and setting `available_at=now()`.

## Install

```bash
helm install thechat-api ./deploy/api
```
