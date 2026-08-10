#!/usr/bin/env bash
#
# Copies the merged Allure results out of a running environment.
#
#   ./scripts/fetch-results.sh --namespace pr-123 --release pr-123 --output ./results
#
# `kubectl cp` needs a container that is still running, and by this point the
# aggregator Job has finished. The chart therefore keeps a small results-exporter
# pod alive with the same volume mounted; this script talks to that.

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

POD="${RELEASE}-test-env-results-exporter"

if ! kubectl -n "$NAMESPACE" get pod "$POD" >/dev/null 2>&1; then
  warn "results exporter pod '$POD' not found — was resultsExporter.enabled set to false?"
  exit 1
fi

info "waiting for $POD to be ready"
kubectl -n "$NAMESPACE" wait --for=condition=ready --timeout="$TIMEOUT" "pod/$POD" >/dev/null

mkdir -p "$OUTPUT"

# kubectl cp is quiet about a missing source path, so the copy is verified after
# the fact rather than trusted.
kubectl -n "$NAMESPACE" cp "$POD:/results/merged" "$OUTPUT/merged" >/dev/null 2>&1 || true

if [[ -d "$OUTPUT/merged/allure-results" ]]; then
  count=$(find "$OUTPUT/merged/allure-results" -type f | wc -l | tr -d ' ')
  ok "copied $count file(s) to $OUTPUT/merged"
else
  warn "nothing was copied — the aggregator may not have run"
  exit 1
fi

# The per-shard directories are useful when a single shard misbehaves.
kubectl -n "$NAMESPACE" exec "$POD" -- sh -c 'ls -d /results/shard-* 2>/dev/null || true' \
  | while read -r shard_dir; do
      [[ -n "$shard_dir" ]] || continue
      name=$(basename "$shard_dir")
      kubectl -n "$NAMESPACE" cp "$POD:$shard_dir/shard-info.json" "$OUTPUT/$name-info.json" >/dev/null 2>&1 || true
    done

if [[ -f "$OUTPUT/merged/summary.md" ]]; then
  echo
  cat "$OUTPUT/merged/summary.md"
fi
