#!/usr/bin/env bash
#
# Proves the environment is gone.
#
#   ./scripts/verify-teardown.sh --namespace pr-123
#
# The README claims these environments are ephemeral. This is the step that
# turns that claim into something a CI log can show: after teardown the
# namespace must not exist, and neither must the cluster-scoped RBAC objects the
# chart created — those outlive a namespace deletion if nobody removes them, and
# are the classic way a "fully cleaned up" cluster slowly fills with junk.
#
# Exit codes: 0 everything is gone, 1 something is still there.

set -Eeuo pipefail

NAMESPACE=""
RELEASE="${RELEASE:-}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-120}"

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
bad()  { printf '    %s✗%s %s\n' "$RED" "$RESET" "$*"; }
info() { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="${2:?--namespace needs a value}"; shift 2 ;;
    --release)   RELEASE="${2:?--release needs a value}"; shift 2 ;;
    --timeout)   TIMEOUT_SECONDS="${2:?--timeout needs a value}"; shift 2 ;;
    -h|--help)   sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *)           echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$NAMESPACE" ]] || { echo "--namespace is required" >&2; exit 2; }

printf '\n%s==> Verifying teardown of namespace '%s'%s\n' "$BOLD" "$NAMESPACE" "$RESET"

failures=0

# 1. The namespace itself. A namespace can sit in Terminating for a while, so
#    this waits rather than checking once.
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
while kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; do
  phase=$(kubectl get namespace "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || echo unknown)
  if [[ $(date +%s) -ge $deadline ]]; then
    bad "namespace '$NAMESPACE' still exists after ${TIMEOUT_SECONDS}s (phase: $phase)"
    kubectl get all -n "$NAMESPACE" 2>/dev/null | head -20 || true
    failures=$((failures + 1))
    break
  fi
  info "namespace is $phase, waiting…"
  sleep 3
done
kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || ok "namespace '$NAMESPACE' does not exist"

# 2. Cluster-scoped leftovers. These are not namespaced, so deleting the
#    namespace does not remove them.
for kind in clusterrole clusterrolebinding; do
  leftovers=$(kubectl get "$kind" -o name 2>/dev/null | grep -- "-${NAMESPACE}$" || true)
  if [[ -n "$leftovers" ]]; then
    bad "cluster-scoped $kind objects survived teardown:"
    printf '        %s\n' "$leftovers"
    failures=$((failures + 1))
  else
    ok "no leftover ${kind}s"
  fi
done

# 3. PersistentVolumes released by the namespace's PVCs. A Retain reclaim policy
#    leaves these behind, which is how a cluster quietly runs out of storage.
orphans=$(kubectl get pv -o jsonpath="{range .items[?(@.spec.claimRef.namespace=='$NAMESPACE')]}{.metadata.name}{'\n'}{end}" 2>/dev/null || true)
if [[ -n "$orphans" ]]; then
  bad "PersistentVolumes still bound to the deleted namespace:"
  printf '        %s\n' "$orphans"
  failures=$((failures + 1))
else
  ok "no orphaned PersistentVolumes"
fi

# 4. The Helm release record.
if [[ -n "$RELEASE" ]]; then
  if helm status "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1; then
    bad "helm release '$RELEASE' still recorded"
    failures=$((failures + 1))
  else
    ok "no helm release record"
  fi
fi

echo
if [[ $failures -eq 0 ]]; then
  printf '%s✓ Teardown verified: nothing from this environment remains.%s\n\n' "$GREEN" "$RESET"
  exit 0
fi

printf '%s✗ Teardown incomplete: %d check(s) failed.%s\n\n' "$RED" "$failures" "$RESET"
exit 1
