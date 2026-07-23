#!/usr/bin/env bash
set -euo pipefail

: "${ATTACHMENT_S3_BUCKET:?Set ATTACHMENT_S3_BUCKET}"
: "${ATTACHMENT_API_AWS_PROFILE:?Set ATTACHMENT_API_AWS_PROFILE to the API-role profile}"
: "${ATTACHMENT_WORKER_AWS_PROFILE:?Set ATTACHMENT_WORKER_AWS_PROFILE to the worker-role profile}"

region="${ATTACHMENT_S3_REGION:-eu-central-1}"
bucket="$ATTACHMENT_S3_BUCKET"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
quarantine_key="quarantine/canary/${run_id}"
clean_key="clean/canary/${run_id}"
workdir="${XDG_CACHE_HOME:-$HOME/.cache}/thechat-attachment-canary/${run_id}"
mkdir -p "$workdir"
printf 'TheChat attachment least-privilege canary %s\n' "$run_id" >"$workdir/payload.txt"
checksum="$(openssl dgst -sha256 -binary "$workdir/payload.txt" | openssl base64 -A)"
quarantine_version=""
clean_version=""

aws_api() {
  AWS_PROFILE="$ATTACHMENT_API_AWS_PROFILE" aws --region "$region" "$@"
}

aws_worker() {
  AWS_PROFILE="$ATTACHMENT_WORKER_AWS_PROFILE" aws --region "$region" "$@"
}

expect_denied() {
  local label="$1"
  shift
  if "$@" >"$workdir/denied.stdout" 2>"$workdir/denied.stderr"; then
    printf 'FAIL (unexpectedly allowed): %s\n' "$label" >&2
    return 1
  fi
  if ! grep -Eqi 'AccessDenied|UnauthorizedOperation|not authorized|Forbidden' "$workdir/denied.stderr"; then
    printf 'FAIL (unexpected error instead of an authorization denial): %s\n' "$label" >&2
    sed -n '1,12p' "$workdir/denied.stderr" >&2
    return 1
  fi
  printf 'PASS denied: %s\n' "$label"
}

cleanup() {
  set +e
  if [[ -n "$clean_version" && "$clean_version" != "None" ]]; then
    aws_worker s3api delete-object \
      --bucket "$bucket" --key "$clean_key" --version-id "$clean_version" \
      >/dev/null 2>&1
  fi
  if [[ -n "$quarantine_version" && "$quarantine_version" != "None" ]]; then
    aws_worker s3api delete-object \
      --bucket "$bucket" --key "$quarantine_key" --version-id "$quarantine_version" \
      >/dev/null 2>&1
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

printf 'Canary bucket: %s (%s)\n' "$bucket" "$region"

quarantine_version="$(
  aws_api s3api put-object \
    --bucket "$bucket" \
    --key "$quarantine_key" \
    --body "$workdir/payload.txt" \
    --content-type text/plain \
    --checksum-algorithm SHA256 \
    --checksum-sha256 "$checksum" \
    --query VersionId \
    --output text
)"
printf 'PASS allowed: API PutObject quarantine (version %s)\n' "$quarantine_version"

aws_api s3api head-object \
  --bucket "$bucket" --key "$quarantine_key" --version-id "$quarantine_version" \
  >/dev/null
printf 'PASS allowed: API HeadObject quarantine version\n'

aws_worker s3api get-object \
  --bucket "$bucket" --key "$quarantine_key" --version-id "$quarantine_version" \
  "$workdir/worker-read.txt" >/dev/null
cmp "$workdir/payload.txt" "$workdir/worker-read.txt"
printf 'PASS allowed: worker GetObject quarantine version\n'

clean_version="$(
  aws_worker s3api copy-object \
    --bucket "$bucket" \
    --key "$clean_key" \
    --copy-source "${bucket}/${quarantine_key}?versionId=${quarantine_version}" \
    --metadata-directive REPLACE \
    --content-type text/plain \
    --checksum-algorithm SHA256 \
    --query VersionId \
    --output text
)"
printf 'PASS allowed: worker CopyObject to clean (version %s)\n' "$clean_version"

aws_api s3api get-object \
  --bucket "$bucket" --key "$clean_key" --version-id "$clean_version" \
  "$workdir/api-read.txt" >/dev/null
cmp "$workdir/payload.txt" "$workdir/api-read.txt"
printf 'PASS allowed: API GetObject clean version\n'

expect_denied "API DeleteObjectVersion quarantine" \
  aws_api s3api delete-object \
  --bucket "$bucket" --key "$quarantine_key" --version-id "$quarantine_version"
expect_denied "API PutObject clean" \
  aws_api s3api put-object \
  --bucket "$bucket" --key "clean/canary/forbidden-${run_id}" \
  --body "$workdir/payload.txt"
expect_denied "API ListBucket" \
  aws_api s3api list-objects-v2 --bucket "$bucket" --max-items 1
expect_denied "worker PutObject quarantine" \
  aws_worker s3api put-object \
  --bucket "$bucket" --key "quarantine/canary/forbidden-${run_id}" \
  --body "$workdir/payload.txt"
expect_denied "worker ListBucket" \
  aws_worker s3api list-objects-v2 --bucket "$bucket" --max-items 1

aws_worker s3api delete-object \
  --bucket "$bucket" --key "$clean_key" --version-id "$clean_version" >/dev/null
clean_version=""
aws_worker s3api delete-object \
  --bucket "$bucket" --key "$quarantine_key" --version-id "$quarantine_version" >/dev/null
quarantine_version=""
printf 'PASS allowed: worker DeleteObjectVersion quarantine and clean\n'
printf 'Attachment S3 least-privilege canary passed.\n'
