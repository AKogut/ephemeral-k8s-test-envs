{{/*
Naming and labelling helpers.

Every object in an ephemeral environment carries the same label set so that a
single selector can find, describe or delete an entire environment — which is
what makes `kubectl get all -l app.kubernetes.io/instance=pr-123` a useful
answer to "what is actually running for that PR?".
*/}}

{{- define "test-env.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "test-env.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "test-env.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels shared by every object. */}}
{{- define "test-env.labels" -}}
helm.sh/chart: {{ include "test-env.chart" . }}
{{ include "test-env.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: ephemeral-test-env
ephemeral-test-envs.io/env-id: {{ include "test-env.envId" . | quote }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "test-env.selectorLabels" -}}
app.kubernetes.io/name: {{ include "test-env.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Per-component selector labels.
Usage: {{ include "test-env.componentSelectorLabels" (dict "context" . "component" "gateway") }}
*/}}
{{- define "test-env.componentSelectorLabels" -}}
{{ include "test-env.selectorLabels" .context }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "test-env.componentLabels" -}}
{{ include "test-env.labels" .context }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* The environment identifier, defaulting to the namespace it is installed in. */}}
{{- define "test-env.envId" -}}
{{- default .Release.Namespace .Values.envId -}}
{{- end -}}

{{/* Image tag, defaulting to the chart's appVersion. */}}
{{- define "test-env.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}

{{/*
Fully-qualified image reference for a component.
Usage: {{ include "test-env.image" (dict "context" . "component" "gateway") }}
*/}}
{{- define "test-env.image" -}}
{{- $registry := .context.Values.image.registry -}}
{{- $namespace := .context.Values.image.namespace -}}
{{- $tag := include "test-env.imageTag" .context -}}
{{- if $registry -}}
{{- printf "%s/%s/%s:%s" $registry $namespace .component $tag -}}
{{- else -}}
{{- printf "%s/%s:%s" $namespace .component $tag -}}
{{- end -}}
{{- end -}}

{{- define "test-env.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "test-env.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Object names, centralised so templates never build them by hand. */}}
{{- define "test-env.authServiceName" -}}{{ include "test-env.fullname" . }}-auth{{- end -}}
{{- define "test-env.notesServiceName" -}}{{ include "test-env.fullname" . }}-notes{{- end -}}
{{- define "test-env.gatewayServiceName" -}}{{ include "test-env.fullname" . }}-gateway{{- end -}}
{{- define "test-env.secretName" -}}
{{- default (printf "%s-jwt" (include "test-env.fullname" .)) .Values.jwt.existingSecret -}}
{{- end -}}
{{- define "test-env.secretKey" -}}
{{- if .Values.jwt.existingSecret -}}{{ .Values.jwt.existingSecretKey }}{{- else -}}jwt-secret{{- end -}}
{{- end -}}
{{- define "test-env.authUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%d" (include "test-env.authServiceName" .) .Release.Namespace (int .Values.auth.port) -}}
{{- end -}}

{{- define "test-env.notesUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%d" (include "test-env.notesServiceName" .) .Release.Namespace (int .Values.notes.port) -}}
{{- end -}}

{{- define "test-env.gatewayUrl" -}}
{{- printf "http://%s.%s.svc.cluster.local:%d" (include "test-env.gatewayServiceName" .) .Release.Namespace (int .Values.gateway.service.port) -}}
{{- end -}}

{{/*
Environment variables every service shares.
*/}}
{{- define "test-env.commonEnv" -}}
- name: NODE_ENV
  value: production
- name: ENV_ID
  value: {{ include "test-env.envId" . | quote }}
- name: GIT_SHA
  value: {{ include "test-env.imageTag" . | quote }}
- name: SERVICE_VERSION
  value: {{ include "test-env.imageTag" . | quote }}
- name: JWT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "test-env.secretName" . }}
      key: {{ include "test-env.secretKey" . }}
- name: JWT_ISSUER
  value: {{ .Values.jwt.issuer | quote }}
- name: JWT_AUDIENCE
  value: {{ .Values.jwt.audience | quote }}
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: POD_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
{{- end -}}

{{/* Validation that fails the render rather than the rollout. */}}
{{- define "test-env.validate" -}}
{{- if not (has .Values.notes.authMode (list "jwt-only" "verify-with-auth-service")) -}}
{{- fail (printf "notes.authMode must be jwt-only or verify-with-auth-service, got %q" .Values.notes.authMode) -}}
{{- end -}}
{{- end -}}
