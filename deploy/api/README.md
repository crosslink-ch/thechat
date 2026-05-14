# thechat-api Helm Chart

Deploys the TheChat API server and bot worker to Kubernetes.

## Prerequisites

- Kubernetes 1.24+
- Helm 3+
- An external PostgreSQL database
- An external Redis instance for realtime fanout and BullMQ workers
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

## Install

```bash
helm install thechat-api ./deploy/api
```
