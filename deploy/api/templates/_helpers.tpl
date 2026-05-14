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

{{- define "thechat-api.env" -}}
{{- range $key, $value := .Values.env }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.databaseSecret }}
      key: DATABASE_URL
- name: JWT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.jwtSecret }}
      key: JWT_SECRET
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
