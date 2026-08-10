#!/usr/bin/env python3
"""Assert that rendered chart manifests actually carry the security defaults.

    helm template … > rendered.yaml
    python3 scripts/assert-security-defaults.py rendered.yaml

A security context that is documented but not rendered is worse than one that is
absent, because it reads as done. This is the check that keeps values.yaml and
the templates honest with each other.
"""
import sys

import yaml

docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
deployments = [d for d in docs if d["kind"] == "Deployment"]
assert deployments, "no Deployments rendered"

for d in deployments:
    name = d["metadata"]["name"]
    spec = d["spec"]["template"]["spec"]
    assert spec["securityContext"]["runAsNonRoot"] is True, f"{name}: not runAsNonRoot"
    assert spec.get("automountServiceAccountToken") is False, f"{name}: mounts a SA token"
    for c in spec["containers"]:
        sc = c["securityContext"]
        assert sc["readOnlyRootFilesystem"] is True, f"{name}: writable root filesystem"
        assert sc["allowPrivilegeEscalation"] is False, f"{name}: privilege escalation allowed"
        assert sc["capabilities"]["drop"] == ["ALL"], f"{name}: capabilities not dropped"
        assert "livenessProbe" in c and "readinessProbe" in c, f"{name}: missing probes"
    print(f"  {name}: security context and probes OK")

sas = [d for d in docs if d["kind"] == "ServiceAccount"]
for sa in sas:
    assert sa.get("automountServiceAccountToken") is False, \
        f"{sa['metadata']['name']}: service account allows token automount"
    print(f"  {sa['metadata']['name']}: no token automount OK")

print("all rendered workloads satisfy the chart's stated security defaults")
