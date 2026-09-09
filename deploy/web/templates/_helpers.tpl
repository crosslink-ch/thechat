{{- define "thechat-web.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "thechat-web.labels" -}}
app.kubernetes.io/name: thechat-web
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "thechat-web.image" -}}
{{- if and .Values.production (not .Values.image.digest) -}}
{{- fail "production requires image.digest (verified registry sha256 digest)" -}}
{{- end -}}
{{- if .Values.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .Values.image.digest) -}}
{{- fail "image.digest must be sha256 followed by 64 lowercase hex characters" -}}
{{- end -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (required "image.tag required without digest" .Values.image.tag) -}}
{{- end -}}
{{- end -}}
