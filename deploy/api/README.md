# thechat-api Helm Chart

Deploys the TheChat API server and bot worker to Kubernetes.

## Prerequisites

- Kubernetes 1.24+
- Helm 3+
- An external PostgreSQL database
- An external Redis instance for realtime fanout and BullMQ workers
- Existing application Secrets in the target namespace
- Infisical Secrets Operator when `attachments.infisical.enabled=true`

## Secrets

By default, the chart references existing Kubernetes Secrets by name. With the optional Infisical integration below, the Infisical operator creates the two attachment credential Secrets. Create the remaining Secrets before installing:

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
and enabling static attachment credentials additionally rejects mutable or
non-SHA tags. During an upgrade, the old workloads keep serving while the hook
runs, so schema changes must remain backward compatible with the currently
deployed version.

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
python3 deploy/api/tests/test_attachment_credentials.py
```

## Worker

With `worker.enabled=true` (the default), the chart also renders:

- a dedicated worker `Deployment` running `bun run dist/scripts/worker.js`;
- a dedicated worker `ServiceAccount` (override with `worker.serviceAccount.name`);
- shared runtime configuration through the same Redis and application Secret references.

## Production attachment credentials

The API and attachment worker use separate Kubernetes service accounts and can use
separate existing Secrets for static AWS IAM-user credentials:

```yaml
attachments:
  credentials:
    enabled: true
    api:
      secretName: thechat-attachments-api-aws
    worker:
      secretName: thechat-attachments-worker-aws
```

Only `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are injected, through explicit
`secretKeyRef` entries. The API Deployment never references the worker Secret, and
the worker Deployment never references the API Secret. No Secret values belong in
Helm values.

`attachments.infisical.enabled=true` additionally renders two
`secrets.infisical.com/v1alpha1` `InfisicalSecret` resources. They authenticate with
two different machine identities bound to the workload-specific service accounts,
read separate Infisical paths, copy only the two named AWS keys into their managed
Kubernetes Secrets, and annotate both Deployments for auto-reload after rotation.
The chart rejects reused ServiceAccounts, Secrets, paths, or machine identities,
and rejects literal `AWS_*` environment overrides.

Preserve the current release values, layer `values-production.example.yaml` on
top, set its blank non-secret bucket, project, and two identity coordinates
outside Git, and render before applying. Infisical sync fails closed if any
coordinate is missing or credential injection is disabled. The full provisioning
and rotation procedure is in
[`deployment/aws/attachments/PRODUCTION.md`](../../deployment/aws/attachments/PRODUCTION.md).

## Installation

```bash
helm install thechat-api ./deploy/api
```
