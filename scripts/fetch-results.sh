#!/usr/bin/env bash
#
# Copies the merged Allure results out of a running environment.
#
#   ./scripts/fetch-results.sh --namespace pr-123 --release pr-123 --output ./results
#
# The aggregator has already put the merged report in the bucket, so this is a
# download rather than a copy out of a pod. The bucket is a ClusterIP Service,
# which a port-forward makes reachable from here.

set -Eeuo pipefail

NAMESPACE=""
RELEASE="${RELEASE:-demo}"
OUTPUT="${OUTPUT:-./results}"
TIMEOUT="${TIMEOUT:-120s}"

DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
info() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="${2:?}"; shift 2 ;;
    --release)   RELEASE="${2:?}"; shift 2 ;;
    --output)    OUTPUT="${2:?}"; shift 2 ;;
    -h|--help)   sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *)           echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$NAMESPACE" ]] || { echo "--namespace is required" >&2; exit 2; }

S3_SECRET="${RELEASE}-test-env-s3"
MINIO_SVC="${RELEASE}-test-env-minio"

info "results are in object storage; forwarding $MINIO_SVC"

PORT="${S3_LOCAL_PORT:-19000}"
kubectl -n "$NAMESPACE" port-forward "svc/$MINIO_SVC" "$PORT:9000" >/dev/null 2>&1 &
FORWARD_PID=$!
trap 'kill "$FORWARD_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/minio/health/live" >/dev/null 2>&1 && break
  sleep 1
done

# Downloads are additive, so a reused output directory quietly ends up holding
# several runs at once. Anything derived from it afterwards — weights, in
# particular — is then inflated by however many runs were in there, which is a
# wrong number that looks entirely plausible.
rm -rf "${OUTPUT:?}/merged"

SYNC_CLI="$(dirname "${BASH_SOURCE[0]}")/dist/sync-results.js"
if [[ ! -f "$SYNC_CLI" ]]; then
  warn "scripts/dist is not built — run: npm --prefix scripts run build"
  exit 1
fi

# The bucket name is chart configuration rather than a secret, so it comes
# from the environment with the chart's default.
RESULTS_S3_ENDPOINT="http://127.0.0.1:$PORT" \
RESULTS_S3_BUCKET="${RESULTS_S3_BUCKET:-results}" \
RESULTS_S3_ACCESS_KEY_ID="$(kubectl -n "$NAMESPACE" get secret "$S3_SECRET" -o jsonpath='{.data.access-key-id}' | base64 -d)" \
RESULTS_S3_SECRET_ACCESS_KEY="$(kubectl -n "$NAMESPACE" get secret "$S3_SECRET" -o jsonpath='{.data.secret-access-key}' | base64 -d)" \
  node "$SYNC_CLI" --download "$NAMESPACE" --into "$OUTPUT"

if [[ -f "$OUTPUT/merged/summary.md" ]]; then
  count=$(find "$OUTPUT/merged/allure-results" -type f 2>/dev/null | wc -l | tr -d ' ')
  ok "downloaded $count file(s) to $OUTPUT/merged"
  echo
  cat "$OUTPUT/merged/summary.md"
  exit 0
fi

warn "the bucket holds no merged report — the aggregator may not have run"
exit 1
