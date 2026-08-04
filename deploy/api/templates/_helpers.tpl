{{- define "thechat-api.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "thechat-api.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "thechat-api.serviceAccountName" -}}
{{- $serviceAccount := .Values.serviceAccount | default dict -}}
{{- default (include "thechat-api.fullname" .) (get $serviceAccount "name") }}
{{- end }}

{{- define "thechat-api.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "thechat-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "thechat-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "thechat-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "thechat-api.workerFullname" -}}
{{- $base := include "thechat-api.fullname" . | trunc 56 | trimSuffix "-" -}}
{{- printf "%s-worker" $base -}}
{{- end }}

{{- define "thechat-api.workerServiceAccountName" -}}
{{- $serviceAccount := .Values.worker.serviceAccount | default dict -}}
{{- default (include "thechat-api.workerFullname" .) (get $serviceAccount "name") }}
{{- end }}

{{- define "thechat-api.infisicalCompatibleSecretName" -}}
{{- $name := toString . -}}
{{- if gt (len $name) 48 -}}
{{- $hash := sha256sum $name | trunc 8 -}}
{{- printf "%s-%s" ($name | trunc 39 | trimSuffix "-") $hash -}}
{{- else -}}
{{- $name -}}
{{- end -}}
{{- end }}

{{- define "thechat-api.attachmentApiSecretName" -}}
{{- $attachments := .Values.attachments | default dict -}}
{{- $credentials := get $attachments "credentials" | default dict -}}
{{- $api := get $credentials "api" | default dict -}}
{{- $configured := get $api "secretName" -}}
{{- if $configured -}}
{{- $configured | trunc 253 | trimSuffix "-" -}}
{{- else -}}
{{- include "thechat-api.infisicalCompatibleSecretName" (printf "%s-attachments-api-aws" (include "thechat-api.fullname" .)) -}}
{{- end -}}
{{- end }}

{{- define "thechat-api.attachmentWorkerSecretName" -}}
{{- $attachments := .Values.attachments | default dict -}}
{{- $credentials := get $attachments "credentials" | default dict -}}
{{- $worker := get $credentials "worker" | default dict -}}
{{- $configured := get $worker "secretName" -}}
{{- if $configured -}}
{{- $configured | trunc 253 | trimSuffix "-" -}}
{{- else -}}
{{- include "thechat-api.infisicalCompatibleSecretName" (printf "%s-attachments-worker-aws" (include "thechat-api.fullname" .)) -}}
{{- end -}}
{{- end }}

{{- define "thechat-api.validateAttachmentIdentityIsolation" -}}
{{- if and .Values.worker.enabled (eq (include "thechat-api.serviceAccountName" .) (include "thechat-api.workerServiceAccountName" .)) -}}
{{- fail "API and worker service accounts must be distinct" -}}
{{- end -}}
{{- $env := .Values.env | default dict -}}
{{- $reservedEnvNames := list "AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY" "AWS_SESSION_TOKEN" "AWS_SECURITY_TOKEN" "AWS_PROFILE" "AWS_SHARED_CREDENTIALS_FILE" "AWS_CONFIG_FILE" "AWS_WEB_IDENTITY_TOKEN_FILE" "AWS_ROLE_ARN" "AWS_ROLE_SESSION_NAME" "AWS_CONTAINER_CREDENTIALS_FULL_URI" "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" "AWS_CONTAINER_AUTHORIZATION_TOKEN" "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE" "DATABASE_URL" "JWT_SECRET" "REDIS_URL" "SMTP_HOST" "SMTP_PORT" "SMTP_USER" "SMTP_PASS" "POSTMARK_API_TOKEN" -}}
{{- range $key, $_ := $env -}}
{{- $keyUpper := upper $key -}}
{{- if or (regexMatch "^AWS_" $keyUpper) (has $keyUpper $reservedEnvNames) -}}
{{- fail (printf "env.%s is reserved for secretKeyRef or the AWS credential provider and cannot be rendered literally" $key) -}}
{{- end -}}
{{- end -}}
{{- $attachments := .Values.attachments | default dict -}}
{{- $credentials := get $attachments "credentials" | default dict -}}
{{- if get $credentials "enabled" -}}
{{- $bucket := required "env.ATTACHMENT_S3_BUCKET is required when attachment credentials are enabled" (get $env "ATTACHMENT_S3_BUCKET" | toString | trim) -}}
{{- $region := required "env.ATTACHMENT_S3_REGION is required when attachment credentials are enabled" (get $env "ATTACHMENT_S3_REGION" | toString | trim) -}}
{{- $imageTag := required "image.tag is required when attachment credentials are enabled" (.Values.image.tag | toString | trim) -}}
{{- $migrateImageTag := required "migrateImage.tag is required when attachment credentials are enabled" (.Values.migrateImage.tag | toString | trim) -}}
{{- if not (regexMatch "^sha-[0-9a-f]{7,64}$" $imageTag) -}}
{{- fail "image.tag must be an immutable sha-<hex> tag when attachment credentials are enabled" -}}
{{- end -}}
{{- if not (regexMatch "^sha-[0-9a-f]{7,64}$" $migrateImageTag) -}}
{{- fail "migrateImage.tag must be an immutable sha-<hex> tag when attachment credentials are enabled" -}}
{{- end -}}
{{- $api := get $credentials "api" | default dict -}}
{{- $apiAccessKey := required "attachments.credentials.api.accessKeyIdKey is required when attachment credentials are enabled" (get $api "accessKeyIdKey") -}}
{{- $apiSecretKey := required "attachments.credentials.api.secretAccessKeyKey is required when attachment credentials are enabled" (get $api "secretAccessKeyKey") -}}
{{- if eq $apiAccessKey $apiSecretKey -}}
{{- fail "attachments.credentials.api access-key and secret-key entries must be distinct" -}}
{{- end -}}
{{- if .Values.worker.enabled -}}
{{- $worker := get $credentials "worker" | default dict -}}
{{- $workerAccessKey := required "attachments.credentials.worker.accessKeyIdKey is required when attachment credentials are enabled" (get $worker "accessKeyIdKey") -}}
{{- $workerSecretKey := required "attachments.credentials.worker.secretAccessKeyKey is required when attachment credentials are enabled" (get $worker "secretAccessKeyKey") -}}
{{- if eq $workerAccessKey $workerSecretKey -}}
{{- fail "attachments.credentials.worker access-key and secret-key entries must be distinct" -}}
{{- end -}}
{{- if eq (include "thechat-api.attachmentApiSecretName" .) (include "thechat-api.attachmentWorkerSecretName" .) -}}
{{- fail "API and worker attachment credential Secrets must be distinct" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $infisical := get $attachments "infisical" | default dict -}}
{{- if get $infisical "enabled" -}}
{{- $apiPath := required "attachments.infisical.apiSecretsPath is required when Infisical synchronization is enabled" (get $infisical "apiSecretsPath") -}}
{{- $workerPath := required "attachments.infisical.workerSecretsPath is required when Infisical synchronization is enabled" (get $infisical "workerSecretsPath") -}}
{{- if eq $apiPath $workerPath -}}
{{- fail "API and worker Infisical paths must be distinct" -}}
{{- end -}}
{{- $identityId := required "attachments.infisical.identityId is required when Infisical synchronization is enabled" (get $infisical "identityId") -}}
{{- $apiSecretName := include "thechat-api.attachmentApiSecretName" . -}}
{{- $workerSecretName := include "thechat-api.attachmentWorkerSecretName" . -}}
{{- if gt (len $apiSecretName) 48 -}}
{{- fail "the API managed Secret name must be at most 48 characters for Infisical auto-reload compatibility" -}}
{{- end -}}
{{- if gt (len $workerSecretName) 48 -}}
{{- fail "the worker managed Secret name must be at most 48 characters for Infisical auto-reload compatibility" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{- define "thechat-api.apiAwsCredentialEnv" -}}
{{- include "thechat-api.validateAttachmentIdentityIsolation" . -}}
{{- $attachments := .Values.attachments | default dict -}}
{{- $credentials := get $attachments "credentials" | default dict -}}
{{- if get $credentials "enabled" }}
{{- $api := get $credentials "api" | default dict }}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "thechat-api.attachmentApiSecretName" . }}
      key: {{ required "attachments.credentials.api.accessKeyIdKey is required when attachment credentials are enabled" (get $api "accessKeyIdKey") | quote }}
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "thechat-api.attachmentApiSecretName" . }}
      key: {{ required "attachments.credentials.api.secretAccessKeyKey is required when attachment credentials are enabled" (get $api "secretAccessKeyKey") | quote }}
{{- end }}
{{- end }}

{{- define "thechat-api.workerAwsCredentialEnv" -}}
{{- $attachments := .Values.attachments | default dict -}}
{{- $credentials := get $attachments "credentials" | default dict -}}
{{- if get $credentials "enabled" }}
{{- $worker := get $credentials "worker" | default dict }}
- name: AWS_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "thechat-api.attachmentWorkerSecretName" . }}
      key: {{ required "attachments.credentials.worker.accessKeyIdKey is required when attachment credentials are enabled" (get $worker "accessKeyIdKey") | quote }}
- name: AWS_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "thechat-api.attachmentWorkerSecretName" . }}
      key: {{ required "attachments.credentials.worker.secretAccessKeyKey is required when attachment credentials are enabled" (get $worker "secretAccessKeyKey") | quote }}
{{- end }}
{{- end }}

{{- define "thechat-api.migrationFullname" -}}
{{- $base := include "thechat-api.fullname" . | trunc 55 | trimSuffix "-" -}}
{{- printf "%s-migrate" $base -}}
{{- end }}

{{- define "thechat-api.migrationName" -}}
{{- $base := include "thechat-api.name" . | trunc 55 | trimSuffix "-" -}}
{{- printf "%s-migrate" $base -}}
{{- end }}

{{- define "thechat-api.migrationLabels" -}}
{{- $migrateImage := default (dict) .Values.migrateImage -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "thechat-api.migrationSelectorLabels" . }}
app.kubernetes.io/version: {{ get $migrateImage "tag" | default .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "thechat-api.migrationSelectorLabels" -}}
app.kubernetes.io/name: {{ include "thechat-api.migrationName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "thechat-api.workerName" -}}
{{- $base := include "thechat-api.name" . | trunc 56 | trimSuffix "-" -}}
{{- printf "%s-worker" $base -}}
{{- end }}

{{- define "thechat-api.workerLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "thechat-api.workerSelectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "thechat-api.workerSelectorLabels" -}}
app.kubernetes.io/name: {{ include "thechat-api.workerName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "thechat-api.redisFullname" -}}
{{- printf "%s-redis" (include "thechat-api.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "thechat-api.redisName" -}}
{{- printf "%s-redis" (include "thechat-api.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "thechat-api.redisLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "thechat-api.redisSelectorLabels" . }}
app.kubernetes.io/version: {{ .Values.redis.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "thechat-api.redisSelectorLabels" -}}
app.kubernetes.io/name: {{ include "thechat-api.redisName" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "thechat-api.redisUrl" -}}
redis://{{ include "thechat-api.redisFullname" . }}.{{ .Release.Namespace }}.svc.cluster.local:{{ .Values.redis.service.port }}/0
{{- end }}

{{- define "thechat-api.env" -}}
{{- $configuredEnv := default (dict) .Values.env -}}
{{- $backendUrl := default "https://api.thechat.app" (index $configuredEnv "THECHAT_BACKEND_URL") -}}
{{- $defaultEnv := dict
  "NODE_ENV" "production"
  "BETTER_AUTH_URL" $backendUrl
  "AUTH_TRUST_PROXY" "true"
  "AUTH_TRUSTED_IP_HEADER" "x-real-ip"
  "REALTIME_DRIVER" "redis"
  "REDIS_KEY_PREFIX" "thechat"
  "REQUIRE_EMAIL_VERIFICATION" "false"
-}}
{{- $effectiveEnv := mergeOverwrite (deepCopy $defaultEnv) $configuredEnv -}}
{{- range $key, $value := $defaultEnv -}}
{{- if or (not (hasKey $effectiveEnv $key)) (eq (index $effectiveEnv $key) nil) -}}
{{- $_ := set $effectiveEnv $key $value -}}
{{- end -}}
{{- end -}}
{{- range $key, $value := $effectiveEnv }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.databaseSecret }}
      key: DATABASE_URL
{{- $betterAuthSecret := "thechat-better-auth" -}}
{{- if and (hasKey .Values "betterAuthSecret") (ne .Values.betterAuthSecret nil) -}}
{{- $betterAuthSecret = required "betterAuthSecret is required" .Values.betterAuthSecret -}}
{{- end }}
- name: BETTER_AUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $betterAuthSecret }}
      key: BETTER_AUTH_SECRET
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.redisSecret }}
      key: REDIS_URL
{{- if .Values.smtpSecret }}
- name: SMTP_HOST
  valueFrom:
    secretKeyRef:
      name: {{ .Values.smtpSecret }}
      key: SMTP_HOST
- name: SMTP_PORT
  valueFrom:
    secretKeyRef:
      name: {{ .Values.smtpSecret }}
      key: SMTP_PORT
- name: SMTP_USER
  valueFrom:
    secretKeyRef:
      name: {{ .Values.smtpSecret }}
      key: SMTP_USER
- name: SMTP_PASS
  valueFrom:
    secretKeyRef:
      name: {{ .Values.smtpSecret }}
      key: SMTP_PASS
{{- end }}
{{- if .Values.postmarkSecret }}
- name: POSTMARK_API_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postmarkSecret }}
      key: POSTMARK_API_TOKEN
{{- end }}
{{- end }}
