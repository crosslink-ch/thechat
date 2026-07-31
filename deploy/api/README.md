# thechat-api Helm Chart

Deploys the TheChat API server and bot worker to Kubernetes.

## Prerequisites

- Kubernetes 1.24+
- Helm 3+
- An external PostgreSQL database
- An external Redis instance for realtime fanout and BullMQ workers
- Existing application Secrets in the target namespace
- Infisical Secrets Operator when `attachments.infisical.enabled=true` or
  `betterAuthInfisical.enabled=true`

## Secrets

By default, the chart references existing Kubernetes Secrets by name. The
optional Infisical integrations create the two attachment credential Secrets
and the Better Auth Secret. Create the remaining Secrets before installing:

```bash
# Required
kubectl create secret generic thechat-db --from-literal=DATABASE_URL='postgresql://user:pass@host:5432/thechat'
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

In production, store `BETTER_AUTH_SECRET` in Infisical and let the Infisical
Secrets Operator materialize the Kubernetes Secret consumed by the API:

```yaml
betterAuthSecret: thechat-better-auth
betterAuthInfisical:
  enabled: true
  hostAPI: https://eu.infisical.com/api
  identityId: <thechat-kubernetes-auth-identity-id>
  projectSlug: <thechat-project-slug>
  envSlug: prod
  secretsPath: /auth
  resyncInterval: 60s
```

The Infisical path must contain `BETTER_AUTH_SECRET` with at least 32 bytes of
high-entropy random data. The operator uses the chart-managed API ServiceAccount
for Kubernetes Auth, writes only that key to `thechat-better-auth`, and restarts
the API and worker workloads when the value changes. If the integration is
disabled, `betterAuthSecret` must reference an existing Kubernetes Secret.

Set `env.BETTER_AUTH_URL` to the public origin of the API. The chart injects
`BETTER_AUTH_SECRET` explicitly from `betterAuthSecret`; production startup
fails without it. Better Auth owns human credentials, opaque human sessions,
and bot API keys. Bot keys are hashed in the Better Auth `apikey` table and are
returned in plaintext only when created or reissued.

The bot-key migration intentionally does not copy credentials from
`bots.api_key`. Deploying it invalidates every existing bot token. Owners must
reissue each bot credential through the existing regenerate-key action before
restarting Hermes or other bot clients with the new value. See
[`docs/bot-api-key-migration.md`](../../docs/bot-api-key-migration.md) for the
rollout and Hermes webhook cutover.

## Better Auth security

The chart also sets `AUTH_TRUST_PROXY=true` and trusts only `x-real-ip` for the
ingress path. Keep the Service private (`ClusterIP`) and use an ingress/proxy
that overwrites that header. If clients can connect directly, set
`AUTH_TRUST_PROXY=false`; client-supplied proxy headers are then ignored. The
wrapper copies the resolved address into a private Better Auth header, so direct
requests cannot choose their own rate-limit bucket.

Human Better Auth sessions expire after 30 days and refresh their server-side
expiry at most once per day. The WebSocket fanout path revalidates the opaque
session before every private delivery, so logout or expiry stops both outbound
mutations and passive inbound events on an already-open socket.

The desktop stores its single opaque session credential in the local SQLite
`kv_store`. Moving authentication credentials to an OS keychain or Stronghold
requires a separate desktop storage and recovery design.

Registration returns `409` for an existing email. The login, verification, and
resend routes use generic unknown-account responses, and the resend and OTP
verification routes share database-backed per-client rate limits across API
replicas.

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

The Better Auth migration is an intentional clean break from the former human-auth schema
and must run against a fresh database selected by `databaseSecret`; it is not an
in-place upgrade for a database that already contains the former auth tables.
During the hook, existing workloads continue using the database configuration
with which they were started, and the new workloads start only after the fresh
database migration succeeds.

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
one shared Kubernetes Auth machine identity using the workload-specific service
account tokens, read separate Infisical paths, copy only the two named AWS keys
into their managed Kubernetes Secrets, and annotate both Deployments for
auto-reload after rotation. The chart rejects reused ServiceAccounts, Secrets,
or paths, and rejects literal `AWS_*` environment overrides.

Preserve the current release values, layer `values-production.example.yaml` on
top, set its blank non-secret bucket, project, and identity coordinates
outside Git, and render before applying. Infisical sync fails closed if any
coordinate is missing or credential injection is disabled. The full provisioning
and rotation procedure is in
[`deployment/aws/attachments/PRODUCTION.md`](../../deployment/aws/attachments/PRODUCTION.md).

## Installation

```bash
helm install thechat-api ./deploy/api
```
