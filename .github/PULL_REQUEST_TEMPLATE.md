# What and why

<!-- What changes, and what problem it solves. Link the issue: Closes #12 -->

## How it was verified

<!-- Delete what does not apply. An unchecked box is fine; an untrue checked box is not. -->

- [ ] `npm run typecheck`
- [ ] `npm run test:unit` — the 72 unit tests
- [ ] `npm run helm:lint`
- [ ] `./scripts/local-demo.sh` — the full lifecycle on kind
- [ ] The API suite passes against a running environment
- [ ] Verified by hand (say how, below)

## Environment impact

<!-- Anything touching the chart, the Jobs or teardown. -->

- [ ] No change to the chart
- [ ] Chart changed — `helm template` output reviewed
- [ ] Teardown path affected — `verify-teardown.sh` still passes
- [ ] New image or new dependency — size impact noted

## Notes for the reviewer

<!--
Anything worth flagging: a decision with a real alternative, a trade-off taken
deliberately, or a part you are unsure about. If the change alters a documented
guarantee, update the doc in this PR and say so here.
-->

---

<sub>The CI run will stand up an ephemeral environment for this PR, run the suite
sharded across 4 pods, post the summary as a comment, and then destroy the
environment. If the summary comment does not appear, the workflow log will say
why.</sub>
