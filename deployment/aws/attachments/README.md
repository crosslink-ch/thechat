# TheChat attachment storage on AWS

This directory contains separate development and production definitions for
private S3-backed message attachments.

- `cloudformation.yaml` is the source of truth for the existing
  `thechat-attachments-dev` stack and its assume-role canaries.
- `cloudformation-production.yaml` defines a production bucket plus dedicated API
  and worker IAM users for static-key authentication. It never creates or outputs
  access keys.
- `PRODUCTION.md` is the approval-gated provisioning, Infisical, deployment, key
  rotation, and emergency-revocation runbook.

The repository contains definitions only. Validation does not provision AWS
resources, write Infisical secrets, or change Kubernetes.

## Shared storage controls

Both templates manage:

- a private bucket with S3-managed `AES256` encryption;
- bucket-owner-enforced ownership and all public-access blocks enabled;
- versioning and retained data if the stack is removed or replaced;
- TLS-only access and bounded presigned-request age;
- one-day quarantine expiry;
- one-day cleanup of incomplete multipart uploads.

The production definition additionally retains its bucket policy, rejects SSE-C
and explicit non-SSE-S3 encryption, removes expired delete markers, and retains
both current and noncurrent clean versions for at least 30 days. Its 15-minute
signature-age ceiling matches the application's maximum upload TTL. Production
bucket names exclude dots so packaged clients use TLS virtual-host addressing
without wildcard-certificate ambiguity.

The production CORS rule permits only packaged Tauri desktop origins:

- `http://tauri.localhost` for the default Windows custom-protocol mapping
- `tauri://localhost` for the packaged Linux and macOS custom protocol

The development template additionally permits the two explicit Vite localhost
origins. Neither template uses a wildcard origin.

## Production identities

`cloudformation-production.yaml` creates two retained named IAM users and two
separately detachable, non-overlapping IAM policies:

- API: one-shot `s3:PutObject` under `quarantine/` only when
  `If-None-Match: *` is present and the request is not a copy, latest-object
  verification under `quarantine/`, and version-pinned reads under `clean/`.
- Worker: version-pinned reads under both prefixes, `s3:PutObject` under
  `clean/` only for copies sourced from `quarantine/`, unversioned quarantine
  cleanup, and version-pinned deletion under both prefixes.

Neither user can list the bucket. The API cannot promote or delete objects, and the
worker cannot create quarantine uploads. The template deliberately has no
`AWS::IAM::AccessKey` resource. Generate and rotate keys separately, then write
them directly to the workload-specific Infisical paths described in
`PRODUCTION.md`.

The Helm chart creates separate API and worker Kubernetes service accounts,
synchronizes two independently scoped Infisical paths into two Kubernetes Secrets,
and injects `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` through explicit
`secretKeyRef` entries. No credential value belongs in Helm values or Git.

## Local validation

Use the same checks as CI:

```bash
cfn-lint \
  deployment/aws/attachments/cloudformation.yaml \
  deployment/aws/attachments/cloudformation-production.yaml
python3 deployment/aws/attachments/test_cloudformation.py
helm lint deploy/api
python3 deploy/api/tests/test_migration_hook.py
python3 deploy/api/tests/test_attachment_credentials.py
```

AWS can also parse either template without creating a stack:

```bash
aws --profile crosslink-admin \
  --region eu-central-1 \
  cloudformation validate-template \
  --template-body file://deployment/aws/attachments/cloudformation.yaml

aws --profile crosslink-admin \
  --region eu-central-1 \
  cloudformation validate-template \
  --template-body file://deployment/aws/attachments/cloudformation-production.yaml
```

The production template uses named IAM users, so an eventual stack deployment
requires `CAPABILITY_NAMED_IAM`. Even a non-executed change set is an AWS-side
effect and should only be created after explicit approval.

## Application configuration

The API and worker share non-secret storage coordinates:

```dotenv
ATTACHMENT_S3_BUCKET=replace-with-stack-output
ATTACHMENT_S3_REGION=eu-central-1
ATTACHMENT_S3_ENDPOINT=
ATTACHMENT_S3_FORCE_PATH_STYLE=false
```

The AWS SDK obtains credentials from its default provider chain. In production,
the chart supplies only the two static IAM-user variables from distinct Kubernetes
Secrets. Ordinary IAM user keys do not require `AWS_SESSION_TOKEN`.

The presigned PUT signs the declared media type, content length, SHA-256 checksum,
and `If-None-Match`. The desktop never receives AWS keys through message or event
contracts. It receives only short-lived presigned requests from authorized API
endpoints.

## Least-privilege canary

The development template retains the broad local role for debugging and defines
separate API and worker canary roles. The same script is also the production
acceptance test when the profiles contain the two dedicated user credentials.
Configure the split profiles, then run:

```bash
ATTACHMENT_S3_BUCKET=thechat-attachments-dev-033581704576 \
ATTACHMENT_S3_REGION=eu-central-1 \
ATTACHMENT_API_AWS_PROFILE=thechat-attachments-api-canary \
ATTACHMENT_WORKER_AWS_PROFILE=thechat-attachments-worker-canary \
deployment/aws/attachments/canary.sh
```

The canary proves conditional API upload/head/version-pinned download, worker
validation-read/quarantine-to-clean copy/version-pinned delete, and denials for
list, non-conditional API upload, API delete/clean writes, worker quarantine or
direct clean writes, and clean-to-clean copy. It uses unique keys and removes
both exact versions with the worker identity on exit.

## Validation scope

The worker validates pinned size and checksum metadata, re-hashes downloaded bytes,
rejects unsupported or mismatched file signatures, blocks active text and
executable or archive signatures, validates JSON, and enforces raster dimension
limits before promotion. Antivirus scanning is not currently part of the attachment
pipeline.
