# Browser production deployment

## Contract and release boundaries

- Frontend: `https://thechat.pranexa.com`, independent **thechat-web** Helm release.
- Browser API: `https://thechat-api.pranexa.com`; WebSocket: `wss://thechat-api.pranexa.com/ws`.
- Desktop API stays `https://thechat.testkopie.dev`, routed to the **same existing API Service**.
- No new backend, database, worker, Redis, bucket, API proxy or browser bearer-token storage.
- Image builds bake the public API/WS URLs. Pod env cannot change them. A URL change requires rebuilding the image and reviewing `nginx.conf` CSP together.
- Node `cl-agent-storage-vbe` is storage-only: the web production overlay excludes it with required node affinity. Existing API/worker placement is deliberately untouched.

`web-image.yml` publishes only trusted `main`, after building and smoking that exact local image, to `ghcr.io/crosslink-ch/thechat-web:sha-<full SHA>`. It does not deploy. The full-SHA tag is provenance, **not** the immutability guarantee: use the registry `sha256` digest recorded in the workflow summary. The web production chart rejects missing/malformed digests. Registry write access and cluster/AWS/DNS changes remain distinct operator boundaries. PR definition/image checks have no registry login or cloud credentials.

## Before mutation (controller only)

1. Pin the reviewed merge SHA and successful API, migrate and web image builds/digests. API/migrate tags must match under the existing API chart contract. Verify the actual image revisions, not `latest`.
2. Discover the exact context, namespace and last successful API release revision. Capture `helm history`, `helm get values --all --revision <last-good>`, the manifest, Deployment images and healthy Service endpoints. Keep exports private/off Git. A failed/current revision is not necessarily last-good.
3. Review effective values. Preserve all references to existing Secrets. Keep attachments/Infisical configuration, SMTP, Redis, resources and placement unchanged. Revision 18 was reported with DB `thechat-db-v3`, auth Secret `thechat-better-auth`, SMTP Secret `thechat-smtp`, `EMAIL_PROVIDER=smtp`, and **`REQUIRE_EMAIL_VERIFICATION=true`**. These are required live-preservation checks, not authorization to recreate defaults. The test fixture is not a deployable values file.
4. Confirm no unexpected database migration delta. Helm's pre-upgrade migration hook still runs; rollback cannot undo a schema/data change. Keep the same database and existing credentials.
5. Verify both new DNS A/AAAA records point to the intended ingress and that `letsencrypt-prod` is Ready with Traefik HTTP01. Validate actual TLS certificates without `-k` after issuance. Do not remove/replace the legacy shared default certificate.
6. Confirm the cluster can pull the image. If GHCR visibility requires authentication, set `imagePullSecrets` to an **existing** namespace Secret; do not add registry credentials to Git or the devbox.

## Render and review the API overlay

Set `KUBE_CONTEXT`, `NAMESPACE`, `LAST_GOOD_API_REVISION`, `API_IMAGE_TAG` and `WEB_IMAGE_DIGEST` from verified live/build evidence. Commands below are operator recipes, not automatic deploy-on-merge behavior.

```sh
umask 077
helm --kube-context "$KUBE_CONTEXT" -n "$NAMESPACE" get values thechat-api \
  --all --revision "$LAST_GOOD_API_REVISION" > current-api-values.yaml

helm template thechat-api deploy/api -n "$NAMESPACE" \
  -f current-api-values.yaml -f deploy/api/values-web-production.yaml \
  --set-string image.tag="$API_IMAGE_TAG" \
  --set-string migrateImage.tag="$API_IMAGE_TAG" > proposed-api.yaml

THECHAT_LIVE_VALUES="$PWD/current-api-values.yaml" python3 deploy/web/tests/test_chart.py

helm template thechat-web deploy/web -n "$NAMESPACE" \
  -f deploy/web/values-production.yaml \
  --set-string image.digest="$WEB_IMAGE_DIGEST" > proposed-web.yaml
```

Compare effective before/after resources, including env and Secret references. Arrays replace: `values-web-production.yaml` explicitly retains both API hosts and adds TLS **only** for `thechat-api.pranexa.com` using `thechat-api-pranexa-tls`. The legacy host retains its default-certificate behavior. If live hosts/TLS changed after revision 18, merge them deliberately rather than blindly applying this list. Existing ingress annotations merge as maps; recheck them against the live snapshot.

Do not use the stale `deploy/api/values.yaml` or attachment example as a production replacement. Prefer an explicit saved live values file plus this small overlay over relying on implicit `--reuse-values`/chart-default behavior. `THECHAT_WEB_ORIGINS` is exactly `https://thechat.pranexa.com` with no wildcard/path/trailing slash. Both backend canonical URL settings become `https://thechat-api.pranexa.com`. No insecure-loopback flag is needed or should be enabled.

After review, the operator may upgrade the **existing** API release with the same arguments plus `helm upgrade --atomic --wait --timeout 10m`. Then install/upgrade only `thechat-web` with its production values and verified image digest (`--atomic --wait --timeout 5m`). Do not apply the web chart to the API release name. Web creates only Deployment, Service and Ingress; no stateful resources or migration hooks.

## S3 browser CORS (separate AWS approval/change set)

`deployment/aws/attachments/cloudformation-production.yaml` adds only optional `BrowserOrigin`. It defaults to empty; the only nonempty allowed value is `https://thechat.pranexa.com`. Existing packaged-desktop CORS, IAM, encryption, public-access blocks, versioning, retention and lifecycle remain unchanged.

On the controller, create/review a change set for the existing `thechat-attachments-production` stack using `BrowserOrigin=https://thechat.pranexa.com` and **UsePreviousValue for every existing parameter**. Require only an in-place bucket CORS update: no replacements, new credentials, IAM broadening or other resources. Follow `deployment/aws/attachments/PRODUCTION.md` for the AWS workflow. After execution, read the stack parameters and actual bucket CORS back. Verify preflight + browser presigned PUT/GET and desktop attachment flows. Revert by returning BrowserOrigin to empty; do not delete/recreate the bucket.

The API overlay sets `ATTACHMENT_S3_PUBLIC_ENDPOINT=https://s3.dualstack.eu-central-1.amazonaws.com` for IPv4/IPv6-capable public presigned URLs, preserving the existing internal client, bucket and `forcePathStyle=false`. The frontend CSP permits both `https://*.s3.dualstack.eu-central-1.amazonaws.com` and legacy `https://*.s3.eu-central-1.amazonaws.com`; confirm actual PUT/GET URL hosts and IPv6 transfers before rollout. Cross-region/custom-endpoint storage requires an explicit CSP/image review, not `connect-src *`.

## Auth and end-to-end acceptance

Existing source already provides the correct protocol; no application behavior change is needed:

- Browser Treaty transport sends `credentials: include`, `X-TheChat-Client: web`, and strips Authorization. Auth is a host-only `__Host-thechat_session` cookie with `Path=/; HttpOnly; Secure; SameSite=Lax`, no Domain.
- Both new HTTPS hosts share the same schemeful site (`pranexa.com`) but are different origins. CORS must admit only the web origin with credentials. The browser sends Origin on cross-origin reads. The existing GET/HEAD normalization fallback applies only to explicitly trusted **same-origin** reads with verified Fetch Metadata + Referer; mutations cannot use it.
- WebSockets connect directly to `/ws`; the browser supplies Origin/cookie during the handshake and sends `{type:"auth",mode:"cookie"}` after open. The server validates the original handshake, not a JS-supplied bearer token. CORS does not authorize WebSockets.

After both rollouts and certificates are healthy, verify exact workload digests/revisions, pod readiness, endpoints, required storage-node exclusion, and `/healthz` over IPv4 and IPv6. Then use fresh browser profiles to verify login/email verification, reload/deep links, `/auth/me`, direct cross-origin requests, cookie attributes, WS auth/reconnect and representative chat plus attachment PUT/GET. Use an untrusted-origin/third profile for negative cookie/API/WS access. Verify desktop bearer login/chat/attachments via the unchanged legacy host. No authenticated live claims follow from render/static-container tests alone.

## Rollback

Record both release pre-states before mutation. If web was a first install, uninstall **only** `thechat-web`; otherwise `helm rollback` it to the saved revision and verify. If a later web or external acceptance step fails after API succeeded, restore the API's recorded last-good revision as a separate compensation step. `--atomic` on the web release does not roll back the earlier API release. Preserve database, Redis, workers, bucket and credentials throughout. Do not remove the legacy API route. Revert browser S3 CORS separately if desired. Keep published digests reachable for the rollback window.

## Local/CI validation

From the real repository cwd (Corepack selects pinned pnpm 10.28.2):

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @thechat/desktop exec tsc --noEmit
corepack pnpm test:web:build
corepack pnpm --filter @thechat/client exec vitest run browser --maxWorkers=2
corepack pnpm --filter @thechat/web exec vitest run browser --maxWorkers=2
bun test packages/api/src/auth/browser-production-policy.test.ts
python3 deploy/web/tests/test_chart.py
python3 deploy/web/tests/test_workflow.py
python3 deploy/web/tests/test_image.py
```

Python render/definition tests require PyYAML and Helm; CloudFormation checks additionally use `cfn-lint==1.53.2`. `test_image.py` builds and tests the actual image, or accepts `THECHAT_WEB_TEST_IMAGE=<existing local handle>`. Its ephemeral test container binds an automatically allocated **loopback-only** port, checks IPv4 plus real in-container IPv6, nonroot/read-only startup, SPA fallback, cache/CSP/header policy and built endpoints, then removes only its own container.
