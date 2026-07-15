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
{{- printf "%s-worker" (include "thechat-api.fullname" .) | trunc 63 | trimSuffix "-" }}
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
{{- printf "%s-worker" (include "thechat-api.name" .) | trunc 63 | trimSuffix "-" }}
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
