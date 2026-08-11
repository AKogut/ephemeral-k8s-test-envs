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
{{- define "test-env.resultsPvcName" -}}{{ include "test-env.fullname" . }}-results{{- end -}}

{{/*
Job names carry the release revision.

A Job's spec is immutable, so a fixed name would make `helm upgrade` fail on the
second deploy to the same namespace — which is exactly what happens when a PR
gets a new commit and its environment is redeployed.
*/}}
{{- define "test-env.shardJobName" -}}
{{- printf "%s-shards-r%d" (include "test-env.fullname" .) (int .Release.Revision) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "test-env.aggregatorJobName" -}}
{{- printf "%s-aggregate-r%d" (include "test-env.fullname" .) (int .Release.Revision) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "test-env.aggregatorServiceAccountName" -}}
{{- printf "%s-aggregator" (include "test-env.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "test-env.teardownJobName" -}}
{{- printf "%s-self-destruct-r%d" (include "test-env.fullname" .) (int .Release.Revision) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "test-env.teardownServiceAccountName" -}}
{{- printf "%s-teardown" (include "test-env.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* In-cluster URLs. Short DNS names would work, but the FQDN makes the
     cross-namespace behaviour explicit and survives a `search` domain change. */}}
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

{{/* True when results go to object storage rather than a shared volume. */}}
{{- define "test-env.resultsOnS3" -}}
{{- eq .Values.tests.results.backend "s3" -}}
{{- end -}}

{{- define "test-env.minioServiceName" -}}
{{- printf "%s-minio" (include "test-env.fullname" .) -}}
{{- end -}}

{{- define "test-env.s3SecretName" -}}
{{- .Values.tests.results.s3.existingSecret | default (printf "%s-s3" (include "test-env.fullname" .)) -}}
{{- end -}}

{{/*
The endpoint pods should use.

An explicit value wins, so an environment can be pointed at a real bucket. With
minio.enabled and nothing explicit, it is the Service this chart creates.
*/}}
{{- define "test-env.s3Endpoint" -}}
{{- if .Values.tests.results.s3.endpoint -}}
{{- .Values.tests.results.s3.endpoint -}}
{{- else -}}
{{- printf "http://%s:9000" (include "test-env.minioServiceName" .) -}}
{{- end -}}
{{- end -}}

{{/*
The storage environment shared by the shard pods and the aggregator.

One definition rather than two copies: the uploader and the downloader
disagreeing about the bucket or the endpoint is a failure that would look like
missing results rather than like a configuration mistake.
*/}}
{{- define "test-env.resultsEnv" -}}
{{- if eq (include "test-env.resultsOnS3" .) "true" }}
- name: RESULTS_S3_ENDPOINT
  value: {{ include "test-env.s3Endpoint" . | quote }}
- name: RESULTS_S3_BUCKET
  value: {{ .Values.tests.results.s3.bucket | quote }}
- name: RESULTS_S3_REGION
  value: {{ .Values.tests.results.s3.region | quote }}
- name: RESULTS_S3_FORCE_PATH_STYLE
  value: {{ .Values.tests.results.s3.forcePathStyle | quote }}
- name: RESULTS_S3_CREATE_BUCKET
  value: {{ .Values.tests.results.s3.createBucket | quote }}
- name: RESULTS_S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "test-env.s3SecretName" . }}
      key: access-key-id
- name: RESULTS_S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "test-env.s3SecretName" . }}
      key: secret-access-key
{{- end }}
{{- end -}}

{{/* Validation that fails the render rather than the rollout. */}}
{{- define "test-env.validate" -}}
{{- if not (has .Values.tests.results.backend (list "pvc" "s3")) -}}
{{- fail (printf "tests.results.backend must be pvc or s3, got %q" .Values.tests.results.backend) -}}
{{- end -}}
{{- if eq .Values.tests.results.backend "s3" -}}
{{- if and (not .Values.minio.enabled) (not .Values.tests.results.s3.endpoint) -}}
{{- fail "tests.results.backend=s3 needs somewhere to write: set minio.enabled=true or tests.results.s3.endpoint" -}}
{{- end -}}
{{- if not .Values.tests.results.s3.bucket -}}
{{- fail "tests.results.backend=s3 requires tests.results.s3.bucket" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.minio.enabled (ne .Values.tests.results.backend "s3") -}}
{{- fail "minio.enabled has no effect unless tests.results.backend=s3 — one of the two is a mistake" -}}
{{- end -}}
{{- if lt (int .Values.tests.shards) 1 -}}
{{- fail (printf "tests.shards must be at least 1, got %v" .Values.tests.shards) -}}
{{- end -}}
{{- if gt (int .Values.tests.shards) 64 -}}
{{- fail (printf "tests.shards is capped at 64 to avoid accidentally requesting a huge Job, got %v" .Values.tests.shards) -}}
{{- end -}}
{{- if not (has .Values.notes.authMode (list "jwt-only" "verify-with-auth-service")) -}}
{{- fail (printf "notes.authMode must be jwt-only or verify-with-auth-service, got %q" .Values.notes.authMode) -}}
{{- end -}}
{{- if and .Values.aggregator.enabled (not .Values.tests.enabled) -}}
{{- fail "aggregator.enabled requires tests.enabled: there would be no shard results to merge" -}}
{{- end -}}
{{- end -}}
