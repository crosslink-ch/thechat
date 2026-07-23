# TheChat attachment storage on AWS

This directory is the source of truth for the existing `thechat-attachments-dev` CloudFormation stack. The template keeps attachment bytes private, encrypted, versioned, and outside PostgreSQL while defining separate API signing/read and worker scanning/promotion/deletion policies.

## Resources

`cloudformation.yaml` manages:

- a private S3 bucket with S3-managed encryption, ownership enforcement, public-access blocks, versioning, exact development CORS origins, and TLS-only access;
- a one-day quarantine expiry, 30-day retention of attached clean objects, and seven-day cleanup of superseded clean versions;
- a bucket policy rejecting presigned requests older than ten minutes;
- the existing broad development role, retained for local debugging and end-to-end tests;
- an API canary role that can only put quarantine objects and read exact quarantine/clean objects;
- a worker canary role that can read quarantine/clean objects, put clean objects, and delete exact object versions.

Neither split role can list the bucket. The API policy cannot promote or delete objects; the worker policy cannot create quarantine uploads. The Helm chart creates separate API and worker service accounts so production can bind each pod to an environment-specific role with the corresponding policy.

## Validate and preview

```bash
aws --profile crosslink-admin cloudformation validate-template \
  --template-body file://deployment/aws/attachments/cloudformation.yaml

aws --profile crosslink-admin cloudformation deploy \
  --stack-name thechat-attachments-dev \
  --template-file deployment/aws/attachments/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --no-execute-changeset
```

Inspect the generated change set before executing it. Preserve the existing `BucketName` and `TrustedPrincipalArn` parameter values on updates. `CleanObjectRetentionDays` defaults to 30 and bounds storage left by database cascades or interrupted cleanup. The bucket and its data are retained if the stack is removed.

## Application configuration

The API and worker use the same non-secret storage coordinates:

```dotenv
ATTACHMENT_S3_BUCKET=thechat-attachments-dev-033581704576
ATTACHMENT_S3_REGION=eu-central-1
ATTACHMENT_S3_ENDPOINT=
ATTACHMENT_S3_FORCE_PATH_STYLE=false
```

The two stack output roles are **canary roles** trusted by `TrustedPrincipalArn` through `sts:AssumeRole`; they are not directly usable as EKS IRSA annotations. For EKS, create two workload roles with `sts:AssumeRoleWithWebIdentity` trust scoped to the API and worker service-account subjects, copy the corresponding least-privilege policy from this template, then place those workload role ARNs in `serviceAccount.annotations` and `worker.serviceAccount.annotations`. For EKS Pod Identity, use `pods.eks.amazonaws.com` trust and separate pod-identity associations instead. Do not put AWS access keys in this repository.

The presigned PUT signs `Content-Length`, constraining the upload to the declared size, and requires the declared media type plus SHA-256 checksum. The browser never receives storage keys through message/event contracts; it receives only short-lived presigned requests from authorized endpoints.

## Least-privilege canary

`canary.sh` performs real allowed and denied operations with separate API and worker profiles. Configure profiles that assume the two stack output roles, then run:

```bash
ATTACHMENT_S3_BUCKET=thechat-attachments-dev-033581704576 \
ATTACHMENT_S3_REGION=eu-central-1 \
ATTACHMENT_API_AWS_PROFILE=thechat-attachments-api-canary \
ATTACHMENT_WORKER_AWS_PROFILE=thechat-attachments-worker-canary \
deployment/aws/attachments/canary.sh
```

The canary proves API upload/head/read, worker scan-read/copy/delete, and denials for list, API delete/clean writes, and worker quarantine writes. It uses unique keys and removes both exact versions with the worker role on exit.

## ClamAV deployment

The Helm chart enables a dedicated ClamAV deployment and ClusterIP service by default; the worker connects to that service on port `3310`. The scanner pod has its own service account with token automount disabled, no AWS annotations, and an ingress policy that admits only worker pods. Set `worker.serviceAccount.annotations` to the production worker workload role and `serviceAccount.annotations` to the production API workload role described above. For local development, run:

```bash
docker compose up -d clamav
CLAMAV_INTEGRATION=1 CLAMAV_HOST=127.0.0.1 CLAMAV_PORT=3310 \
  pnpm --filter @thechat/api exec bun test \
  src/attachments/scanner.integration.test.ts
```

The opt-in test checks a clean payload and the harmless EICAR antivirus test signature. Normal unit suites skip it when no daemon is available.
