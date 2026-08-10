#!/usr/bin/env python3
"""Assert that rendered chart manifests actually carry the security defaults.

    helm template … > rendered.yaml
    python3 scripts/assert-security-defaults.py rendered.yaml

A security context that is documented but not rendered is worse than one that is
absent, because it reads as done. This is the check that keeps values.yaml and
the templates honest with each other.

Note what it does *not* assert: that every ServiceAccount refuses to mount a
token. Two workloads legitimately need one — the aggregator, which reads a Job's
status, and the teardown Job, which deletes its own namespace. Blanket-asserting
"no tokens anywhere" would have to be relaxed the moment either arrives, and a
check that gets relaxed is a check that stops meaning anything.

What it asserts instead is the property that actually matters: **no service
account attached to an application Deployment may mount a token**, and any
account that does mount one must be attached to a Job rather than to a
long-running service.
"""

import sys

import yaml


def main(path: str) -> int:
    docs = [d for d in yaml.safe_load_all(open(path)) if d]

    deployments = [d for d in docs if d["kind"] == "Deployment"]
    jobs = [d for d in docs if d["kind"] in ("Job", "CronJob")]
    accounts = {d["metadata"]["name"]: d for d in docs if d["kind"] == "ServiceAccount"}

    assert deployments, "no Deployments rendered"

    # --- every workload: security context and probes -------------------------
    workloads = [(d, d["spec"]["template"]["spec"]) for d in deployments]
    workloads += [(j, j["spec"]["template"]["spec"]) for j in jobs]

    for obj, spec in workloads:
        name = obj["metadata"]["name"]
        kind = obj["kind"]

        assert spec["securityContext"]["runAsNonRoot"] is True, f"{name}: not runAsNonRoot"
        assert spec["securityContext"]["seccompProfile"]["type"] == "RuntimeDefault", \
            f"{name}: seccomp profile is not RuntimeDefault"

        for container in spec["containers"] + spec.get("initContainers", []):
            sc = container["securityContext"]
            assert sc["readOnlyRootFilesystem"] is True, f"{name}/{container['name']}: writable root filesystem"
            assert sc["allowPrivilegeEscalation"] is False, f"{name}/{container['name']}: privilege escalation allowed"
            assert sc["capabilities"]["drop"] == ["ALL"], f"{name}/{container['name']}: capabilities not dropped"

        # Probes are a Deployment concern; a Job runs to completion.
        if kind == "Deployment":
            for container in spec["containers"]:
                assert "livenessProbe" in container and "readinessProbe" in container, \
                    f"{name}/{container['name']}: missing probes"

        print(f"  {kind}/{name}: security context OK")

    # --- application pods must not hold a cluster credential -----------------
    service_accounts_of_deployments = set()

    for deployment in deployments:
        name = deployment["metadata"]["name"]
        spec = deployment["spec"]["template"]["spec"]
        assert spec.get("automountServiceAccountToken") is False, \
            f"{name}: an application pod must not mount a service account token"
        if "serviceAccountName" in spec:
            service_accounts_of_deployments.add(spec["serviceAccountName"])

    for sa_name in sorted(service_accounts_of_deployments):
        sa = accounts.get(sa_name)
        assert sa is not None, f"{sa_name}: referenced by a Deployment but not rendered"
        assert sa.get("automountServiceAccountToken") is False, \
            f"{sa_name}: service account used by an application pod allows token automount"
        print(f"  ServiceAccount/{sa_name}: no token automount OK")

    # --- any account that *does* mount a token must justify itself -----------
    privileged = {
        job["spec"]["template"]["spec"]["serviceAccountName"]
        for job in jobs
        if job["spec"]["template"]["spec"].get("automountServiceAccountToken") is True
        and "serviceAccountName" in job["spec"]["template"]["spec"]
    }

    for sa_name in sorted(privileged):
        assert sa_name not in service_accounts_of_deployments, \
            f"{sa_name}: an account used by a Job with a token is shared with a Deployment"
        print(f"  ServiceAccount/{sa_name}: mounts a token, used only by Jobs — OK")

    print("all rendered workloads satisfy the chart's stated security defaults")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
