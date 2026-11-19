#!/usr/bin/env bash
set -euo pipefail

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "::error::unsupported architecture $(uname -m)"; exit 1 ;;
esac

bin="${BIN_DIR:?}"
mkdir -p "$bin"

fetch_verified() {
  local url="$1" sum_url="$2" dest="$3" attempt expected actual
  for attempt in 1 2 3 4 5; do
    if curl -fsSL --retry 3 --retry-all-errors -o "$dest" "$url" \
       && expected=$(curl -fsSL --retry 3 --retry-all-errors "$sum_url" | awk '{print $1}') \
       && [ -n "$expected" ] \
       && actual=$( (sha256sum "$dest" 2>/dev/null || shasum -a 256 "$dest") | awk '{print $1}') \
       && [ "$expected" = "$actual" ]; then
      chmod +x "$dest"
      return 0
    fi
    echo "::warning::download or checksum of $url failed (attempt $attempt of 5)"
    sleep $((attempt * 10))
  done
  echo "::error::could not fetch a verified $url"
  return 1
}

fetch_verified "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-${os}-${arch}" \
  "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-${os}-${arch}.sha256sum" \
  "$bin/kind"
fetch_verified "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${os}/${arch}/kubectl" \
  "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${os}/${arch}/kubectl.sha256" \
  "$bin/kubectl"
export PATH="$bin:$PATH"

config_args=()
[ -n "${KIND_CONFIG:-}" ] && config_args=(--config "$KIND_CONFIG")

for attempt in 1 2 3; do
  if kind create cluster --name "$CLUSTER_NAME" --image "$KIND_NODE_IMAGE" "${config_args[@]}" --wait "${KIND_WAIT:-120s}"; then
    kubectl cluster-info --context "kind-$CLUSTER_NAME"
    exit 0
  fi
  echo "::warning::creating the kind cluster failed (attempt $attempt of 3)"
  kind delete cluster --name "$CLUSTER_NAME" || true
  sleep $((attempt * 15))
done
echo "::error::could not create the kind cluster $CLUSTER_NAME"
exit 1
