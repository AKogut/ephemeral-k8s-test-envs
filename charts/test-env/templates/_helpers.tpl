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

{{/*
Where a person opens this environment. The namespace carries the name, so the
URL does too: pr-123.preview.example.com.
*/}}
{{- define "test-env.previewHost" -}}
{{- printf "%s.%s" .Release.Namespace .Values.gateway.ingress.domain -}}
{{- end -}}

{{- define "test-env.previewUrl" -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.gateway.ingress.tls.enabled) (include "test-env.previewHost" .) -}}
{{- end -}}

{{- define "test-env.postgresName" -}}
{{- printf "%s-postgres" (include "test-env.fullname" .) -}}
{{- end -}}

{{- define "test-env.postgresSecretName" -}}
{{- .Values.database.postgres.existingSecret | default (printf "%s-postgres" (include "test-env.fullname" .)) -}}
{{- end -}}

{{/*
Where the services look for Postgres.

An explicit host wins, so an environment can be pointed at a database that
already exists. With `deploy` and nothing explicit, it is the headless Service
this chart creates.
*/}}
{{- define "test-env.postgresHost" -}}
{{- if .Values.database.postgres.host -}}
{{- .Values.database.postgres.host -}}
{{- else -}}
{{- include "test-env.postgresName" . -}}
{{- end -}}
{{- end -}}

{{/*
The database environment for one service. Takes "context" and "database".

The URL is assembled in the pod from parts rather than stored whole, because a
Secret holding `postgres://user:password@host/db` puts the password into
anything that prints the connection string — a log line, an error, `kubectl
describe` of the wrong object. Kubernetes expands $(VAR) against earlier
entries in the same container's env, so only the password comes from the
Secret.

The generated password is alphanumeric for the same reason it has to be: a `@`
or a `/` in it would end the URL somewhere other than where it means to.
*/}}
{{- define "test-env.databaseEnv" -}}
{{- $ctx := .context -}}
{{- $database := .database -}}
- name: DB_BACKEND
  value: {{ $ctx.Values.database.backend | quote }}
{{- if eq $ctx.Values.database.backend "postgres" }}
- name: DB_HOST
  value: {{ include "test-env.postgresHost" $ctx | quote }}
- name: DB_PORT
  value: {{ $ctx.Values.database.postgres.port | quote }}
- name: DB_USER
  value: {{ $ctx.Values.database.postgres.user | quote }}
- name: DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "test-env.postgresSecretName" $ctx }}
      key: password
- name: DATABASE_URL
  value: "postgres://$(DB_USER):$(DB_PASSWORD)@$(DB_HOST):$(DB_PORT)/{{ $database }}"
{{- else }}
- name: DATABASE_PATH
  value: /data/{{ $database }}.sqlite
{{- end }}
{{- end -}}

{{- define "test-env.migrateJobName" -}}
{{- printf "%s-migrate-%s" (include "test-env.fullname" .context) .database -}}
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
{{- end -}}

{{/*
Quantity parsing, so the quota can be computed rather than guessed.

Both are deliberately strict: an unrecognised unit fails the render instead of
being read as zero. A quota that silently under-counts is worse than no quota,
because it looks like protection and blocks pods for reasons nobody can trace.
*/}}
{{- define "test-env.milli" -}}
{{- $v := . | toString -}}
{{- if regexMatch "^[0-9]+m$" $v -}}
{{- trimSuffix "m" $v | int -}}
{{- else if regexMatch "^[0-9]+$" $v -}}
{{- mul ($v | int) 1000 -}}
{{- else -}}
{{- fail (printf "cannot read %q as a CPU quantity — use millicores (\"250m\") or whole cores (\"2\")" $v) -}}
{{- end -}}
{{- end -}}

{{- define "test-env.mebi" -}}
{{- $v := . | toString -}}
{{- if regexMatch "^[0-9]+Mi$" $v -}}
{{- trimSuffix "Mi" $v | int -}}
{{- else if regexMatch "^[0-9]+Gi$" $v -}}
{{- mul (trimSuffix "Gi" $v | int) 1024 -}}
{{- else -}}
{{- fail (printf "cannot read %q as a memory quantity — use Mi or Gi, whole numbers only" $v) -}}
{{- end -}}
{{- end -}}

{{/*
What this environment is entitled to, summed from what it actually declares.

Computed rather than configured, so raising tests.shards raises the quota with
it. A hard-coded number would drift the moment anyone changed a replica count,
and the failure would arrive as a Pending pod rather than as a wrong value.

Returns JSON; call sites do `include ... | fromJson`.
*/}}
{{- define "test-env.quotaTotals" -}}
{{- $reqCpu := 0 -}}{{- $reqMem := 0 -}}{{- $limCpu := 0 -}}{{- $limMem := 0 -}}{{- $pods := 0 -}}

{{- $workloads := list
      (dict "count" (int .Values.gateway.replicaCount) "res" .Values.gateway.resources)
      (dict "count" (int .Values.auth.replicaCount)    "res" .Values.auth.resources)
      (dict "count" (int .Values.notes.replicaCount)   "res" .Values.notes.resources)
-}}
{{- if .Values.minio.enabled -}}
{{- $workloads = append $workloads (dict "count" 1 "res" .Values.minio.resources) -}}
{{- end -}}
{{- if .Values.tests.enabled -}}
{{- $workloads = append $workloads (dict "count" (int .Values.tests.shards) "res" .Values.tests.resources) -}}
{{- if .Values.aggregator.enabled -}}
{{- $workloads = append $workloads (dict "count" 1 "res" .Values.aggregator.resources) -}}
{{- end -}}
{{- end -}}
{{- if .Values.teardown.selfDestruct.enabled -}}
{{- $workloads = append $workloads (dict "count" 1 "res" .Values.teardown.selfDestruct.resources) -}}
{{- end -}}
{{- if eq .Values.database.backend "postgres" -}}
{{- if .Values.database.postgres.deploy -}}
{{- $workloads = append $workloads (dict "count" 1 "res" .Values.database.postgres.resources) -}}
{{- end -}}
{{/*
Both migration Jobs, counted even though they finish. A quota sized for the
steady state rejects the pods that get an environment to it, and reports that
as a Pending pod rather than as a number that was too small.
*/}}
{{- $workloads = append $workloads (dict "count" 2 "res" .Values.database.migrations.resources) -}}
{{- end -}}

{{- range $w := $workloads -}}
{{- $n := $w.count -}}
{{- $pods = add $pods $n -}}
{{- $reqCpu = add $reqCpu (mul $n (include "test-env.milli" $w.res.requests.cpu | int)) -}}
{{- $reqMem = add $reqMem (mul $n (include "test-env.mebi"  $w.res.requests.memory | int)) -}}
{{- $limCpu = add $limCpu (mul $n (include "test-env.milli" $w.res.limits.cpu | int)) -}}
{{- $limMem = add $limMem (mul $n (include "test-env.mebi"  $w.res.limits.memory | int)) -}}
{{- end -}}

{{- $headroom := int .Values.resourceQuota.headroomPercent -}}
{{- dict
      "requestsCpu" (div (mul $reqCpu (add 100 $headroom)) 100)
      "requestsMem" (div (mul $reqMem (add 100 $headroom)) 100)
      "limitsCpu"   (div (mul $limCpu (add 100 $headroom)) 100)
      "limitsMem"   (div (mul $limMem (add 100 $headroom)) 100)
      "pods"        (add $pods (int .Values.resourceQuota.podHeadroom))
      "rawPods"     $pods
   | toJson -}}
{{- end -}}

{{/* Validation that fails the render rather than the rollout. */}}
{{- define "test-env.validate" -}}
{{- if and .Values.tests.enabled (not .Values.minio.enabled) (not .Values.tests.results.s3.endpoint) -}}
{{- fail "results have nowhere to go: set minio.enabled=true or point tests.results.s3.endpoint at a bucket" -}}
{{- end -}}
{{- if and .Values.tests.enabled (not .Values.tests.results.s3.bucket) -}}
{{- fail "tests.results.s3.bucket is required" -}}
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
{{- if and .Values.gateway.ingress.enabled (not .Values.gateway.ingress.domain) -}}
{{- fail "gateway.ingress.domain is required when gateway.ingress.enabled: an Ingress with no host publishes the environment on every hostname the controller answers" -}}
{{- end -}}
{{- if not (has .Values.database.backend (list "sqlite" "postgres")) -}}
{{- fail (printf "database.backend must be sqlite or postgres, got %q" .Values.database.backend) -}}
{{- end -}}
{{- if and (eq .Values.database.backend "postgres") (not .Values.database.postgres.deploy) (not .Values.database.postgres.host) -}}
{{- fail "database.postgres.host is required when database.postgres.deploy=false: there would be nothing to connect to" -}}
{{- end -}}
{{- if and .Values.tests.spread.enabled (not (has .Values.tests.spread.whenUnsatisfiable (list "DoNotSchedule" "ScheduleAnyway"))) -}}
{{- fail (printf "tests.spread.whenUnsatisfiable must be DoNotSchedule or ScheduleAnyway, got %q" .Values.tests.spread.whenUnsatisfiable) -}}
{{- end -}}
{{- if and .Values.tests.spread.enabled (lt (int .Values.tests.spread.maxSkew) 1) -}}
{{- fail (printf "tests.spread.maxSkew must be at least 1, got %v" .Values.tests.spread.maxSkew) -}}
{{- end -}}
{{- if and .Values.aggregator.enabled (not .Values.tests.enabled) -}}
{{- fail "aggregator.enabled requires tests.enabled: there would be no shard results to merge" -}}
{{- end -}}
{{- end -}}
