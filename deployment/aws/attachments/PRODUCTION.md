# Production attachment rollout and rotation runbook

This runbook provisions the production S3/IAM boundary, stores two static AWS
access-key pairs in separate Infisical paths, and deploys the Helm integration.
It does **not** create access keys in CloudFormation or place secret values in
Git, Helm values, shell history, CloudFormation outputs, or logs.

The production cluster is K3s, not EKS. The API and worker therefore use
separate static IAM users, separate Infisical machine identities, separate
Infisical paths, separate Kubernetes ServiceAccounts, and separate Kubernetes
Secrets.

## 0. Fixed production contract

| Concern | Production contract |
| --- | --- |
| Stack | `thechat-attachments-production` |
| Bucket | globally unique, DNS-compatible, no dots |
| API IAM user | `thechat-attachments-prod-api` |
| Worker IAM user | `thechat-attachments-prod-worker` |
| API Infisical path | `/attachments/api` |
| Worker Infisical path | `/attachments/worker` |
| API Kubernetes Secret | `thechat-attachments-api-aws` |
| Worker Kubernetes Secret | `thechat-attachments-worker-aws` |
| API ServiceAccount | `thechat-api` |
| Worker ServiceAccount | `thechat-api-worker` |
| Clean retention | current and noncurrent versions, at least 30 days |
| Quarantine retention | current and noncurrent versions, 1 day |
| Packaged desktop origins | `http://tauri.localhost`, `tauri://localhost` |

The bucket, bucket policy, and IAM users are retained if the stack is deleted or
replaced. The separate `AWS::IAM::Policy` resources detach on stack deletion,
so retained users do not keep stack-managed S3 permissions. Never delete the
stack as a cleanup shortcut.

## 1. Prerequisites

- AWS CLI v2 authenticated to the production account with MFA-backed admin
  access and permission for CloudFormation, S3, and named IAM resources.
- Helm 3.18.6 or newer, `kubectl`, `jq`, OpenSSL, and Infisical CLI.
- Kube context `cl`, namespace `thechat`, and Helm release `thechat`.
- Infisical Operator installed. The current production operator exposes
  `secrets.infisical.com/v1alpha1`; the rendered resources are validated against
  that installed CRD in CI/manual preflight.
- Two **different** Infisical machine identities using Kubernetes auth:
  - API identity: bound only to namespace `thechat`, ServiceAccount
    `thechat-api`, and read access to `/attachments/api`.
  - Worker identity: bound only to namespace `thechat`, ServiceAccount
    `thechat-api-worker`, and read access to `/attachments/worker`.
- A reviewed immutable application image tag in `sha-<git-sha>` form. Use the
  same tag for `image.tag` and `migrateImage.tag`.
- An encrypted operator workstation. Secret-bearing work files below are mode
  `0600`; remove them immediately after validation.

Set non-secret coordinates. Do not put secret values in these variables.

```bash
set -euo pipefail
umask 077

export AWS_PROFILE=<production-admin-profile>
export AWS_REGION=eu-central-1
export STACK_NAME=thechat-attachments-production
export BUCKET_NAME=<globally-unique-name-without-dots>
export API_USER=thechat-attachments-prod-api
export WORKER_USER=thechat-attachments-prod-worker

export KUBE_CONTEXT=cl
export KUBE_NAMESPACE=thechat
export HELM_RELEASE=thechat-api
export IMAGE_TAG=sha-<reviewed-git-sha>

export INFISICAL_API_URL=https://infisical.testkopie.dev/api
export INFISICAL_PROJECT_ID=<production-project-id>
export INFISICAL_PROJECT_SLUG=<production-project-slug>
export API_INFISICAL_ID=<dedicated-api-machine-identity-id>
export WORKER_INFISICAL_ID=<dedicated-worker-machine-identity-id>

test "$API_INFISICAL_ID" != "$WORKER_INFISICAL_ID"
WORKDIR="${XDG_CACHE_HOME:-$HOME/.cache}/thechat-attachments-production"
install -d -m 0700 "$WORKDIR"
```

## 2. Validate and deploy the AWS stack

Run local validation first:

```bash
cfn-lint deployment/aws/attachments/cloudformation-production.yaml
python3 deployment/aws/attachments/test_cloudformation.py
aws cloudformation validate-template \
  --region "$AWS_REGION" \
  --template-body file://deployment/aws/attachments/cloudformation-production.yaml \
  >/dev/null
```

Create a change set instead of deploying blind:

```bash
if aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" >/dev/null 2>&1; then
  CHANGE_SET_TYPE=UPDATE
else
  CHANGE_SET_TYPE=CREATE
fi

CHANGE_SET="attachments-production-$(date -u +%Y%m%dT%H%M%SZ)"
aws cloudformation create-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET" \
  --change-set-type "$CHANGE_SET_TYPE" \
  --template-body file://deployment/aws/attachments/cloudformation-production.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=BucketName,ParameterValue="$BUCKET_NAME" \
    ParameterKey=ApiUserName,ParameterValue="$API_USER" \
    ParameterKey=WorkerUserName,ParameterValue="$WORKER_USER" \
    ParameterKey=CleanObjectRetentionDays,ParameterValue=30

aws cloudformation wait change-set-create-complete \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET"
aws cloudformation describe-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET" \
  --query '{Status:Status,Changes:Changes[].ResourceChange.{Action:Action,LogicalId:LogicalResourceId,Type:ResourceType,Replacement:Replacement}}' \
  --output table
```

Review the change set. It must contain one retained S3 bucket, one retained
bucket policy, two retained IAM users, and two detachable IAM policies. It must
not contain `AWS::IAM::AccessKey`, public S3 access, or an unexpected bucket
replacement.

Execute only after that review:

```bash
aws cloudformation execute-change-set \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET"
aws cloudformation wait stack-${CHANGE_SET_TYPE,,}-complete \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME"

aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}' \
  --output table
```

If the shell's lowercase expansion is unavailable, use
`stack-create-complete` or `stack-update-complete` explicitly.

## 3. Create each initial access key transactionally

Authenticate the Infisical CLI before creating AWS keys. Confirm that both
secret paths exist and each dedicated machine identity can read only its own
path.

The helper below deletes a newly created key automatically if a failure happens
**before** Infisical accepts it. Once Infisical accepts it, the key is retained
for recovery rather than silently deleted out from under a synchronized Secret.
It also refuses to create a second key during initial provisioning.

```bash
create_and_store_initial_key() (
  set -euo pipefail
  umask 077
  local user="$1" secret_path="$2" key_file="$3" env_file="$4"
  local created_key_id="" infisical_committed=0

  rollback_uncommitted_key() {
    local status=$?
    if (( status != 0 )) && [[ -n "$created_key_id" ]] && (( infisical_committed == 0 )); then
      AWS_PROFILE="$AWS_PROFILE" aws iam delete-access-key \
        --user-name "$user" --access-key-id "$created_key_id" || true
      printf 'Deleted uncommitted access key %s for %s after failure.\n' \
        "$created_key_id" "$user" >&2
    fi
    exit "$status"
  }
  trap rollback_uncommitted_key EXIT

  local count
  count="$(AWS_PROFILE="$AWS_PROFILE" aws iam list-access-keys \
    --user-name "$user" --query 'length(AccessKeyMetadata)' --output text)"
  [[ "$count" == "0" ]] || {
    printf 'Refusing initial provisioning: %s already has %s key(s).\n' "$user" "$count" >&2
    exit 1
  }

  AWS_PROFILE="$AWS_PROFILE" aws iam create-access-key \
    --user-name "$user" --output json >"$key_file"
  chmod 0600 "$key_file"
  created_key_id="$(jq -er '.AccessKey.AccessKeyId' "$key_file")"
  jq -er '
    "AWS_ACCESS_KEY_ID=\(.AccessKey.AccessKeyId)\n" +
    "AWS_SECRET_ACCESS_KEY=\(.AccessKey.SecretAccessKey)\n"
  ' "$key_file" >"$env_file"
  chmod 0600 "$env_file"

  infisical secrets set \
    --projectId "$INFISICAL_PROJECT_ID" \
    --env prod \
    --path "$secret_path" \
    --file "$env_file" \
    --silent >/dev/null
  infisical_committed=1
  rm -f "$env_file"
  trap - EXIT
  printf 'Stored access key ID %s for %s at %s.\n' \
    "$created_key_id" "$user" "$secret_path"
)

create_and_store_initial_key \
  "$API_USER" /attachments/api \
  "$WORKDIR/api-access-key.json" "$WORKDIR/api.env"
create_and_store_initial_key \
  "$WORKER_USER" /attachments/worker \
  "$WORKDIR/worker-access-key.json" "$WORKDIR/worker.env"
```

Do not print or paste either `SecretAccessKey`. Access-key IDs are identifiers,
not secrets, and may be used for reconciliation.

If the operator session stops unexpectedly:

1. Run `aws iam list-access-keys --user-name <user>` for each user.
2. Compare the non-secret key IDs with the Infisical audit log and the decoded
   `AWS_ACCESS_KEY_ID` in the corresponding Kubernetes Secret.
3. If Infisical never committed the new key, delete that key immediately.
4. If Infisical committed it, keep it active and finish synchronization and
   rollout verification before deleting anything.

## 4. Preserve current release values and validate the chart

Do not upgrade production from the example file alone. Preserve the current
release's user-supplied values in a protected file, then apply the production
attachment overlay and explicit coordinates.

```bash
helm --kube-context "$KUBE_CONTEXT" get values "$HELM_RELEASE" \
  --namespace "$KUBE_NAMESPACE" --output yaml \
  >"$WORKDIR/current-release-values.yaml"
chmod 0600 "$WORKDIR/current-release-values.yaml"

HELM_COORDINATES=(
  --set-string "image.tag=$IMAGE_TAG"
  --set-string "migrateImage.tag=$IMAGE_TAG"
  --set-string "env.ATTACHMENT_S3_BUCKET=$BUCKET_NAME"
  --set-string "env.ATTACHMENT_S3_REGION=$AWS_REGION"
  --set-string "attachments.infisical.projectSlug=$INFISICAL_PROJECT_SLUG"
  --set-string "attachments.infisical.apiIdentityId=$API_INFISICAL_ID"
  --set-string "attachments.infisical.workerIdentityId=$WORKER_INFISICAL_ID"
)

helm lint deploy/api \
  -f "$WORKDIR/current-release-values.yaml" \
  -f deploy/api/values-production.example.yaml \
  "${HELM_COORDINATES[@]}"

helm template "$HELM_RELEASE" deploy/api \
  --namespace "$KUBE_NAMESPACE" \
  -f "$WORKDIR/current-release-values.yaml" \
  -f deploy/api/values-production.example.yaml \
  "${HELM_COORDINATES[@]}" \
  >"$WORKDIR/rendered-production.yaml"
chmod 0600 "$WORKDIR/rendered-production.yaml"

# Validate the two custom resources against the installed production CRD.
helm template "$HELM_RELEASE" deploy/api \
  --namespace "$KUBE_NAMESPACE" \
  --show-only templates/infisical-attachment-secrets.yaml \
  -f "$WORKDIR/current-release-values.yaml" \
  -f deploy/api/values-production.example.yaml \
  "${HELM_COORDINATES[@]}" \
  | kubectl --context "$KUBE_CONTEXT" apply \
      --namespace "$KUBE_NAMESPACE" --dry-run=server -f -
```

Review the rendered diff. In particular verify:

- only the API Deployment references `thechat-attachments-api-aws`;
- only the worker Deployment references `thechat-attachments-worker-aws`;
- ServiceAccounts and Infisical identity IDs are different;
- both pod specs use `automountServiceAccountToken: false`;
- Infisical resources use `/attachments/api` and `/attachments/worker`;
- image and migration tags are the same immutable SHA;
- no credential value appears in the render.

## 5. Deploy and gate the rollout

```bash
helm upgrade --install "$HELM_RELEASE" deploy/api \
  --kube-context "$KUBE_CONTEXT" \
  --namespace "$KUBE_NAMESPACE" \
  --atomic --timeout 10m \
  -f "$WORKDIR/current-release-values.yaml" \
  -f deploy/api/values-production.example.yaml \
  "${HELM_COORDINATES[@]}"

kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  wait --for=jsonpath='{.status.conditions[?(@.type=="secrets.infisical.com/ReadyToSyncSecrets")].status}'=True \
  infisicalsecret/thechat-api-attachments-api-infisical --timeout=180s
kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  wait --for=jsonpath='{.status.conditions[?(@.type=="secrets.infisical.com/ReadyToSyncSecrets")].status}'=True \
  infisicalsecret/thechat-api-attachments-worker-infisical --timeout=180s

kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  get secret thechat-attachments-api-aws thechat-attachments-worker-aws
kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  rollout status deployment/thechat-api --timeout=5m
kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  rollout status deployment/thechat-api-worker --timeout=5m
```

The installed Infisical Operator watches the auto-reload annotation on
Deployment metadata. A Secret update should produce a new ReplicaSet for only
the workload that owns that Secret.

Verify only access-key IDs, never secret access keys:

```bash
API_K8S_KEY_ID="$(kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  get secret thechat-attachments-api-aws \
  -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)"
WORKER_K8S_KEY_ID="$(kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  get secret thechat-attachments-worker-aws \
  -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)"

test "$API_K8S_KEY_ID" = "$(jq -r '.AccessKey.AccessKeyId' "$WORKDIR/api-access-key.json")"
test "$WORKER_K8S_KEY_ID" = "$(jq -r '.AccessKey.AccessKeyId' "$WORKDIR/worker-access-key.json")"
test "$API_K8S_KEY_ID" != "$WORKER_K8S_KEY_ID"
unset API_K8S_KEY_ID WORKER_K8S_KEY_ID
```

## 6. Run the S3 least-privilege canary

Create a temporary mode-`0600` AWS credentials file from the still-protected
initial key JSON. This avoids placing secret values in command arguments or
shell history.

```bash
CREDS_FILE="$WORKDIR/canary-aws-credentials"
{
  jq -r '"[thechat-attachment-api]\naws_access_key_id = \(.AccessKey.AccessKeyId)\naws_secret_access_key = \(.AccessKey.SecretAccessKey)"' \
    "$WORKDIR/api-access-key.json"
  jq -r '"[thechat-attachment-worker]\naws_access_key_id = \(.AccessKey.AccessKeyId)\naws_secret_access_key = \(.AccessKey.SecretAccessKey)"' \
    "$WORKDIR/worker-access-key.json"
} >"$CREDS_FILE"
chmod 0600 "$CREDS_FILE"

AWS_SHARED_CREDENTIALS_FILE="$CREDS_FILE" \
ATTACHMENT_S3_BUCKET="$BUCKET_NAME" \
ATTACHMENT_S3_REGION="$AWS_REGION" \
ATTACHMENT_API_AWS_PROFILE=thechat-attachment-api \
ATTACHMENT_WORKER_AWS_PROFILE=thechat-attachment-worker \
  deployment/aws/attachments/canary.sh
```

The canary proves the required calls and explicit denials, including
conditional API uploads and quarantine-only worker promotion. It creates only
random canary objects and removes their exact versions on exit.

After the canary and application upload/download flow both pass:

```bash
rm -f \
  "$CREDS_FILE" \
  "$WORKDIR/api-access-key.json" \
  "$WORKDIR/worker-access-key.json" \
  "$WORKDIR/current-release-values.yaml" \
  "$WORKDIR/rendered-production.yaml"
```

## 7. Rotate one workload at a time

Never rotate API and worker keys together. IAM allows at most two keys per user;
an overlapping rotation preserves rollback.

For the workload being rotated, set these four values explicitly:

```bash
# API example. Substitute worker coordinates for a separate worker rotation.
export ROTATE_USER=thechat-attachments-prod-api
export ROTATE_PATH=/attachments/api
export ROTATE_SECRET=thechat-attachments-api-aws
export ROTATE_DEPLOYMENT=thechat-api
```

Back up the current Infisical values to a protected file, then verify that the
user has exactly one active key and fewer than two total keys:

```bash
ROTATION_DIR="$WORKDIR/rotation-${ROTATE_DEPLOYMENT}-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$ROTATION_DIR"

infisical export \
  --projectId "$INFISICAL_PROJECT_ID" \
  --env prod --path "$ROTATE_PATH" \
  --format=dotenv \
  --output-file "$ROTATION_DIR/previous.env" \
  --silent
chmod 0600 "$ROTATION_DIR/previous.env"

aws iam list-access-keys --user-name "$ROTATE_USER" \
  >"$ROTATION_DIR/key-metadata.json"
OLD_KEY_ID="$(jq -er '
  [.AccessKeyMetadata[] | select(.Status == "Active")] as $active |
  if ($active | length) == 1 and (.AccessKeyMetadata | length) < 2
  then $active[0].AccessKeyId
  else error("rotation requires exactly one active key and fewer than two total keys") end
' "$ROTATION_DIR/key-metadata.json")"

aws iam create-access-key --user-name "$ROTATE_USER" \
  >"$ROTATION_DIR/new-key.json"
chmod 0600 "$ROTATION_DIR/new-key.json"
NEW_KEY_ID="$(jq -er '.AccessKey.AccessKeyId' "$ROTATION_DIR/new-key.json")"
jq -er '
  "AWS_ACCESS_KEY_ID=\(.AccessKey.AccessKeyId)\n" +
  "AWS_SECRET_ACCESS_KEY=\(.AccessKey.SecretAccessKey)\n"
' "$ROTATION_DIR/new-key.json" >"$ROTATION_DIR/new.env"
chmod 0600 "$ROTATION_DIR/new.env"

if ! infisical secrets set \
  --projectId "$INFISICAL_PROJECT_ID" \
  --env prod --path "$ROTATE_PATH" \
  --file "$ROTATION_DIR/new.env" --silent >/dev/null; then
  aws iam delete-access-key \
    --user-name "$ROTATE_USER" --access-key-id "$NEW_KEY_ID"
  exit 1
fi
```

Wait for sync and the targeted auto-reload, then compare only the key ID:

```bash
for _ in $(seq 1 36); do
  K8S_KEY_ID="$(kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
    get secret "$ROTATE_SECRET" \
    -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)"
  [[ "$K8S_KEY_ID" == "$NEW_KEY_ID" ]] && break
  sleep 5
done
test "$K8S_KEY_ID" = "$NEW_KEY_ID"
kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  rollout status "deployment/$ROTATE_DEPLOYMENT" --timeout=5m
```

Run the workload-specific application smoke test. During a maintenance window,
run the full least-privilege canary after both workloads have been rotated.
After the soak period, delete the old key:

```bash
aws iam update-access-key \
  --user-name "$ROTATE_USER" --access-key-id "$OLD_KEY_ID" --status Inactive
# Observe one more application/canary cycle before irreversible deletion.
aws iam delete-access-key \
  --user-name "$ROTATE_USER" --access-key-id "$OLD_KEY_ID"
rm -rf "$ROTATION_DIR"
unset OLD_KEY_ID NEW_KEY_ID K8S_KEY_ID
```

### Rotation rollback

If synchronization, rollout, or smoke tests fail before deleting the old key:

```bash
infisical secrets set \
  --projectId "$INFISICAL_PROJECT_ID" \
  --env prod --path "$ROTATE_PATH" \
  --file "$ROTATION_DIR/previous.env" --silent >/dev/null
aws iam update-access-key \
  --user-name "$ROTATE_USER" --access-key-id "$OLD_KEY_ID" --status Active
kubectl --context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  rollout status "deployment/$ROTATE_DEPLOYMENT" --timeout=5m
aws iam delete-access-key \
  --user-name "$ROTATE_USER" --access-key-id "$NEW_KEY_ID"
rm -rf "$ROTATION_DIR"
```

If the rotation session is interrupted, do not guess. Keep both keys active,
compare IAM key IDs, the Infisical audit log, and the Kubernetes Secret's
`AWS_ACCESS_KEY_ID`, then either complete the new-key rollout or restore
`previous.env` before deleting a key.

## 8. Application rollback and stack retirement

For an application rollback, keep the AWS stack and both Infisical Secrets in
place:

```bash
helm --kube-context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  history "$HELM_RELEASE"
helm --kube-context "$KUBE_CONTEXT" -n "$KUBE_NAMESPACE" \
  rollback "$HELM_RELEASE" <known-good-revision> --wait --timeout 10m
```

Before any deliberate CloudFormation deletion:

1. Disable attachment writes and confirm no upload/validation jobs are active.
2. Delete both IAM users' access keys.
3. Archive the Infisical audit trail and delete the two secret paths.
4. Delete the stack. The bucket, bucket policy, and IAM users remain retained;
   the IAM policy resources detach.
5. Inventory all object versions and delete retained resources only under a
   separately reviewed data-destruction plan.

## 9. Handoff checklist

- [ ] Change set reviewed; no unexpected replacement.
- [ ] Bucket and bucket policy are retained, private, versioned, and encrypted.
- [ ] Clean current/noncurrent retention is at least 30 days.
- [ ] IAM users, policies, and access-key IDs are distinct.
- [ ] API/worker Infisical identities and paths are distinct.
- [ ] Installed CRD accepted both rendered `InfisicalSecret` resources.
- [ ] Kubernetes Secrets exist and only expose the matching non-secret key ID.
- [ ] API and worker rolled out independently with immutable SHA images.
- [ ] S3 least-privilege canary passed all positive and negative checks.
- [ ] Real desktop upload, validation/promotion, and download passed.
- [ ] Secret-bearing local files were removed.
- [ ] Rotation owner and next rotation date were recorded.
