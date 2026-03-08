# thechat-api Helm Chart

Deploys the TheChat API server to Kubernetes.

## Prerequisites

- Kubernetes 1.24+
- Helm 3+
- An external PostgreSQL database
- Secrets pre-created in the target namespace (see below)

## Secrets

The chart references existing Kubernetes secrets by name — it does not create them. Create them before installing:

```bash
# Required
kubectl create secret generic thechat-db --from-literal=DATABASE_URL='postgresql://user:pass@host:5432/thechat'
kubectl create secret generic thechat-jwt --from-literal=JWT_SECRET='your-jwt-secret'

# Optional — SMTP credentials
kubectl create secret generic thechat-smtp \
  --from-literal=SMTP_HOST='smtp.example.com' \
  --from-literal=SMTP_PORT='587' \
  --from-literal=SMTP_USER='user' \
  --from-literal=SMTP_PASS='pass'

# Optional — Postmark (alternative to SMTP)
kubectl create secret generic thechat-postmark --from-literal=POSTMARK_API_TOKEN='your-token'
```

## Install

```bash
helm install thechat-api ./deploy/api
```

## Common overrides

```bash
helm install thechat-api ./deploy/api \
  --set image.tag=sha-abc123 \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set smtpSecret=thechat-smtp \
  --set env.THECHAT_BACKEND_URL=https://api.example.com
```

## Values

| Key | Default | Description |
|-----|---------|-------------|
| `replicaCount` | `1` | Number of replicas |
| `image.repository` | `ghcr.io/crosslink-ch/thechat-api` | Container image |
| `image.tag` | `latest` | Image tag |
| `image.pullPolicy` | `IfNotPresent` | Pull policy |
| `databaseSecret` | `thechat-db` | Secret name with `DATABASE_URL` key |
| `jwtSecret` | `thechat-jwt` | Secret name with `JWT_SECRET` key |
| `smtpSecret` | `""` | Secret name with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` keys (disabled if empty) |
| `postmarkSecret` | `""` | Secret name with `POSTMARK_API_TOKEN` key (disabled if empty) |
| `env` | see `values.yaml` | Non-secret environment variables passed to the container |
| `service.type` | `ClusterIP` | Service type |
| `service.port` | `80` | Service port |
| `ingress.enabled` | `false` | Enable ingress |
| `ingress.className` | `""` | Ingress class |
| `ingress.annotations` | `{}` | Ingress annotations |
| `ingress.hosts` | `[{host: api.thechat.app, paths: [{path: /, pathType: Prefix}]}]` | Ingress host rules |
| `ingress.tls` | `[]` | Ingress TLS config |
| `resources.requests.cpu` | `100m` | CPU request |
| `resources.requests.memory` | `128Mi` | Memory request |
| `resources.limits.memory` | `512Mi` | Memory limit |
| `autoscaling.enabled` | `false` | Enable HPA |
| `autoscaling.minReplicas` | `1` | HPA min replicas |
| `autoscaling.maxReplicas` | `5` | HPA max replicas |
| `autoscaling.targetCPUUtilizationPercentage` | `80` | HPA CPU target |
| `nodeSelector` | `{}` | Node selector |
| `tolerations` | `[]` | Tolerations |
| `affinity` | `{}` | Affinity rules |

## Health checks

The deployment uses the `/health` endpoint for both liveness and readiness probes. This endpoint verifies database connectivity and returns `200` when healthy or `503` when the database is unreachable.
