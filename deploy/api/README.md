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

Database migrations run automatically as a blocking Helm `pre-install,pre-upgrade`
hook Job. Helm waits for the migration Job to succeed before creating or updating
the API and worker Deployments, so neither workload can start against a schema
that is still being migrated.

The Job uses the separate `thechat-api-migrate` image, which contains
`drizzle-kit` and the migration files from `packages/api/drizzle/`. Successful
Jobs are deleted automatically. Failed Jobs are retained so their logs remain
available, and the next install or upgrade removes the old Job before retrying.
The database Secret must exist before `helm install`, because pre-install hooks
run before ordinary chart resources are created.

Set `image.tag` and `migrateImage.tag` to the same immutable build tag (for
example, a `sha-*` tag) in production. The chart rejects mismatched tag strings,
but matching mutable tags such as `latest` does not guarantee that both images
contain artifacts from the same build. During an upgrade, the old workloads keep
serving while the hook runs, so schema changes must remain backward compatible
with the currently deployed version.

Migration files must be generated and committed to git before building the image:

```bash
cd packages/api
pnpm db:generate   # generates SQL migration files in drizzle/
```

Run this whenever you change `src/db/schema.ts`, then commit the resulting files in `drizzle/`.

If a migration blocks an install or upgrade, inspect the retained hook Job:

```bash
kubectl get job thechat-api-migrate
kubectl logs job/thechat-api-migrate
```

Validate chart rendering locally with:

```bash
helm lint deploy/api
python3 deploy/api/tests/test_migration_hook.py
```

## Worker

The API Deployment only serves HTTP traffic. Bot jobs are consumed by a separate
worker Deployment controlled by `worker.enabled` in `values.yaml`. The worker
uses the same API image and runs `bun run dist/scripts/worker.js`.

## Install

```bash
helm install thechat-api ./deploy/api
```
