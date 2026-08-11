#!/usr/bin/env bash
#
# One-command local environment: kind cluster -> build images -> deploy.
#
#   ./scripts/local-demo.sh                 # deploy, shard, aggregate, tear down, prove it
#   ./scripts/local-demo.sh --keep          # leave it running to poke at
#   ./scripts/local-demo.sh --shards 8      # more shards
#   ./scripts/local-demo.sh --no-tests      # just stand the environment up
#   ./scripts/local-demo.sh --cleanup-only  # remove a previous run's leftovers
#
# Requires: docker, kind, kubectl, helm. Nothing else, and no cloud account.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CLUSTER_NAME="${CLUSTER_NAME:-ephemeral-test-envs}"
NAMESPACE="${NAMESPACE:-demo-local}"
RELEASE="${RELEASE:-demo}"
IMAGE_TAG="${IMAGE_TAG:-local}"
IMAGE_NAMESPACE="${IMAGE_NAMESPACE:-akogut/ephemeral-k8s-test-envs}"
SHARDS="${SHARDS:-4}"
RESULTS_DIR="${RESULTS_DIR:-$REPO_ROOT/results}"

KEEP=false
RUN_TESTS=true
CLEANUP_ONLY=false
KEEP_CLUSTER=false

# ------------------------------------------------------------------ helpers --

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
step()  { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
info()  { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()   { printf '\n%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'
  exit 0
}

require() {
  for binary in "$@"; do
    command -v "$binary" >/dev/null 2>&1 || die "$binary is required but not installed"
  done
}

# --------------------------------------------------------------------- args --

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)         KEEP=true; shift ;;
    --keep-cluster) KEEP=true; KEEP_CLUSTER=true; shift ;;
    --no-tests)     RUN_TESTS=false; KEEP=true; shift ;;
    --shards)       SHARDS="${2:?--shards needs a value}"; shift 2 ;;
    --cleanup-only) CLEANUP_ONLY=true; shift ;;
    --namespace)    NAMESPACE="${2:?--namespace needs a value}"; shift 2 ;;
    --tag)          IMAGE_TAG="${2:?--tag needs a value}"; shift 2 ;;
    -h|--help)      usage ;;
    *)              die "unknown option: $1 (try --help)" ;;
  esac
done

# ------------------------------------------------------------------ cleanup --

cleanup() {
  local exit_code=$?

  if [[ "$KEEP" == true && $exit_code -eq 0 ]]; then
    step "Leaving the environment running (--keep)"
    cat <<EOF
    Namespace : $NAMESPACE
    Port-forward the gateway:
      kubectl -n $NAMESPACE port-forward svc/${RELEASE}-test-env-gateway 8080:80
      curl -s localhost:8080/readyz

    When you are done:
      $0 --cleanup-only
EOF
    return
  fi

  step "Tearing down"
  # Deliberately not gated on success: a failed run must clean up too.
  if helm uninstall "$RELEASE" -n "$NAMESPACE" --wait --timeout 2m >/dev/null 2>&1; then
    ok "helm release removed"
  else
    warn "no helm release to remove"
  fi

  if kubectl delete namespace "$NAMESPACE" --wait=true --timeout=3m >/dev/null 2>&1; then
    ok "namespace deleted"
  else
    warn "no namespace to delete"
  fi

  # The claim this project makes is that nothing is left behind. Asserting it
  # here means a broken teardown fails the demo rather than going unnoticed.
  "$REPO_ROOT/scripts/verify-teardown.sh" --namespace "$NAMESPACE" --release "$RELEASE" || exit_code=1

  if [[ "$KEEP_CLUSTER" != true ]]; then
    if kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1; then
      ok "kind cluster deleted"
    else
      warn "no kind cluster to delete"
    fi
  fi

  exit $exit_code
}

# ---------------------------------------------------------------------- run --

require docker kind kubectl helm
docker info >/dev/null 2>&1 || die "the docker daemon is not running"

if [[ "$CLEANUP_ONLY" == true ]]; then
  KEEP=false
  cleanup
fi

trap cleanup EXIT

step "Creating kind cluster '$CLUSTER_NAME'"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  info "cluster already exists, reusing it"
else
  kind create cluster --name "$CLUSTER_NAME" --wait 120s
fi
kubectl cluster-info --context "kind-$CLUSTER_NAME" >/dev/null
ok "cluster ready"

step "Building images (tag: $IMAGE_TAG)"
GIT_SHA_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# component : dockerfile : build context
IMAGE_SPECS=(
  "auth-service:app/auth-service/Dockerfile:app/auth-service"
  "notes-service:app/notes-service/Dockerfile:app/notes-service"
  "gateway:app/gateway/Dockerfile:app/gateway"
  # Build context is the repository root: the runner image needs both the suite
  # (tests/api) and the shard planner (scripts), which live in different trees.
  "api-tests:tests/api/Dockerfile:."
  "aggregator:scripts/Dockerfile:scripts"
)

REFS=()
for spec in "${IMAGE_SPECS[@]}"; do
  IFS=':' read -r component dockerfile context <<<"$spec"
  ref="$IMAGE_NAMESPACE/$component:$IMAGE_TAG"
  info "building $component"
  docker build --quiet \
    --build-arg "SERVICE_VERSION=$IMAGE_TAG" \
    --build-arg "GIT_SHA=$GIT_SHA_SHORT" \
    -f "$dockerfile" -t "$ref" "$context" >/dev/null
  REFS+=("$ref")
done
ok "built ${#REFS[@]} images"

step "Loading images into the cluster"
# kind nodes run their own containerd; images must be side-loaded because there
# is no registry in this setup.
kind load docker-image --name "$CLUSTER_NAME" "${REFS[@]}"
ok "images available to the cluster"

step "Installing the chart into namespace '$NAMESPACE'"
helm install "$RELEASE" ./charts/test-env \
  --namespace "$NAMESPACE" --create-namespace \
  --set "image.registry=" \
  --set "image.namespace=$IMAGE_NAMESPACE" \
  --set "image.tag=$IMAGE_TAG" \
  --set "image.pullPolicy=Never" \
  --set "tests.enabled=$RUN_TESTS" \
  --set "tests.shards=$SHARDS" \
  --set "aggregator.enabled=$RUN_TESTS" \
  --wait --timeout 5m
ok "release installed"

step "Waiting for the application to become ready"
kubectl -n "$NAMESPACE" wait --for=condition=available --timeout=5m deployment --all
ok "all deployments available"
kubectl -n "$NAMESPACE" get pods -o wide

if [[ "$RUN_TESTS" == true ]]; then
  SHARD_JOB="${RELEASE}-test-env-shards-r1"

  step "Running $SHARDS test shards"
  info "watch: kubectl -n $NAMESPACE get pods -l app.kubernetes.io/component=api-tests -w"
  TEST_STATUS=0
  kubectl -n "$NAMESPACE" wait --for=condition=complete --timeout=15m "job/$SHARD_JOB" 2>/dev/null \
    || TEST_STATUS=1

  for index in $(seq 0 $((SHARDS - 1))); do
    pod=$(kubectl -n "$NAMESPACE" get pods \
      -l "batch.kubernetes.io/job-name=$SHARD_JOB,batch.kubernetes.io/job-completion-index=$index" \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    [[ -n "$pod" ]] || continue
    printf '\n%s--- shard %s (%s) ---%s\n' "$DIM" "$index" "$pod" "$RESET"
    kubectl -n "$NAMESPACE" logs "$pod" --tail=20 2>/dev/null || true
  done

  step "Aggregating results"
  # The aggregator's initContainer has been waiting for the shard Job since it
  # was created, so by now it is either finished or very nearly so.
  kubectl -n "$NAMESPACE" wait --for=condition=complete --timeout=5m \
    "job/${RELEASE}-test-env-aggregate-r1" 2>/dev/null || true
  kubectl -n "$NAMESPACE" logs "job/${RELEASE}-test-env-aggregate-r1" 2>/dev/null \
    || warn "aggregator produced no logs"

  step "Copying the merged report to $RESULTS_DIR"
  "$REPO_ROOT/scripts/fetch-results.sh" \
    --namespace "$NAMESPACE" --release "$RELEASE" --output "$RESULTS_DIR" \
    || warn "could not copy results out of the cluster"

  step "Done"
  if [[ $TEST_STATUS -eq 0 ]]; then
    ok "all $SHARDS shards passed"
  else
    warn "some shards failed — see the summary above"
  fi
  info "merged Allure results: $RESULTS_DIR/merged/allure-results"
  info "render the report:     npx allure generate $RESULTS_DIR/merged/allure-results --clean -o $RESULTS_DIR/allure-report"
  exit $TEST_STATUS
fi

step "Smoke-testing the environment from inside the cluster"
# Executed inside a running pod so the check goes through the same Service DNS
# the application itself uses, rather than a port-forward that bypasses it.
GATEWAY_URL="http://${RELEASE}-test-env-gateway"
kubectl -n "$NAMESPACE" exec "deploy/${RELEASE}-test-env-gateway" -- node -e "
  (async () => {
    const base = '$GATEWAY_URL';
    const ready = await fetch(base + '/readyz');
    const body = await ready.json();
    console.log('readyz:', body.status, JSON.stringify(body.upstreams));
    if (!ready.ok) process.exit(1);

    const email = 'smoke-' + Date.now() + '@example.test';
    const password = 'correct-horse-battery-staple';
    const json = { 'content-type': 'application/json' };

    const reg = await fetch(base + '/auth/register', {
      method: 'POST', headers: json, body: JSON.stringify({ email, password }),
    });
    console.log('register:', reg.status);

    const login = await fetch(base + '/auth/login', {
      method: 'POST', headers: json, body: JSON.stringify({ email, password }),
    });
    const { token } = await login.json();

    const note = await fetch(base + '/notes', {
      method: 'POST',
      headers: { ...json, authorization: 'Bearer ' + token },
      body: JSON.stringify({ title: 'smoke test', tags: ['smoke'] }),
    });
    console.log('create note:', note.status);
    if (note.status !== 201) process.exit(1);
  })().catch((error) => { console.error(error); process.exit(1); });
" || die "smoke test failed — the environment is up but not working"
ok "register → login → create note succeeded through the gateway"

step "Done"
ok "environment '$NAMESPACE' is up (tests skipped)"
info "port-forward: kubectl -n $NAMESPACE port-forward svc/${RELEASE}-test-env-gateway 8080:80"
