#!/usr/bin/env python3
"""Assert that the shard Job constrains where its pods may run.

    helm template … > rendered.yaml
    python3 scripts/assert-shard-spread.py rendered.yaml

Removing the shared PersistentVolumeClaim (ADR 0007) made it *possible* for the
shards to run on different nodes. It did not make them do it. The scheduler's
own default spreading tolerates a skew of 3, so two shards on one worker of two
is an unremarkable choice for it — and a run in which every shard lands on one
machine is green, correctly reported and half the environment it claims to be.

So the placement is a constraint on the Job rather than a hope about the
scheduler, and this is the check that it stays one. The companion assertion runs
against a live cluster in CI and counts the nodes the pods actually covered;
this one is what fails in seconds when the constraint is deleted from the chart.
"""

import sys

import yaml


def main(path: str) -> int:
    docs = [d for d in yaml.safe_load_all(open(path)) if d]

    jobs = [
        d
        for d in docs
        if d.get("kind") == "Job" and "shards" in d["metadata"]["name"]
    ]
    if not jobs:
        print("no shard Job in the rendered output", file=sys.stderr)
        return 1

    failures = []
    for job in jobs:
        name = job["metadata"]["name"]
        spec = job["spec"]["template"]["spec"]
        constraints = spec.get("topologySpreadConstraints") or []

        if not constraints:
            failures.append(f"{name}: places no constraint on its own spread")
            continue

        for constraint in constraints:
            if constraint.get("topologyKey") != "kubernetes.io/hostname":
                failures.append(
                    f"{name}: spreads by {constraint.get('topologyKey')!r}, "
                    "which says nothing about which machine a shard runs on"
                )
            # Left at the default of Ignore, a node the pod could never run on
            # — a tainted control plane, a drained node — counts as an empty
            # domain. Every real placement then looks skewed, and under
            # DoNotSchedule the Job simply stays Pending.
            if constraint.get("nodeTaintsPolicy") != "Honor":
                failures.append(
                    f"{name}: nodeTaintsPolicy is "
                    f"{constraint.get('nodeTaintsPolicy', 'unset')}, so nodes "
                    "that cannot take a shard still count as domains"
                )
            print(
                f"{name}: maxSkew {constraint.get('maxSkew')} over "
                f"{constraint.get('topologyKey')}, "
                f"{constraint.get('whenUnsatisfiable')}"
            )

    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
