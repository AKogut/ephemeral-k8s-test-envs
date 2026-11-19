#!/usr/bin/env bash
set -euo pipefail

label="main-red"
open=$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --label "$label" --json number --jq '.[0].number // empty')

if [ "$RED" != "true" ]; then
  if [ -n "$open" ]; then
    gh issue close "$open" --repo "$GITHUB_REPOSITORY" --comment "Green again in [run ${RUN_ID}](${RUN_URL})."
    echo "closed #$open"
  else
    echo "main is green"
  fi
  exit 0
fi

if [ "$ATTEMPT" = "1" ]; then
  echo "first attempt failed; the automatic retry decides whether this is reported"
  exit 0
fi

report="\`main\` failed on ${EVENT} in [run ${RUN_ID}](${RUN_URL}), attempt ${ATTEMPT}, after the automatic retry. See docs/ci-pipeline.md, "Between commits"."
if [ -n "$open" ]; then
  gh issue comment "$open" --repo "$GITHUB_REPOSITORY" --body "$report"
  echo "commented on #$open"
else
  gh label create "$label" --repo "$GITHUB_REPOSITORY" --color B60205 --description "The scheduled or post-merge run of main failed" --force >/dev/null
  gh issue create --repo "$GITHUB_REPOSITORY" --title "main is red" --label "$label" --body "$report"
fi
