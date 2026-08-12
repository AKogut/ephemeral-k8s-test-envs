# Code of Conduct

## The short version

Be straightforward and be kind. Argue with the code, not the person who wrote
it.

## What is expected

This repository is about engineering decisions, and most of them had a
reasonable alternative. Disagreement is the point — the ADRs exist because
someone could have chosen otherwise. So:

- **Critique the work.** "This RBAC rule is broader than it needs to be" is
  useful. "Whoever wrote this doesn't understand RBAC" is not, and it is also
  less likely to be right.
- **Say what you actually observed.** A bug report with the `x-request-id` and
  `kubectl get pods` output is worth ten confident guesses about the cause.
- **Assume the other person had a reason.** Ask what it was. Sometimes the
  reason is written down three lines above the code; sometimes it turns out
  there wasn't one, which is also a fine outcome.
- **Accept a "no" with an argument behind it.** Not every proposal fits the
  scope, and scope discipline is part of this project's design.

## What is not

Harassment, personal attacks, demeaning comments, unwelcome attention, and
publishing anyone's private information. Sustained disruption of a discussion
after being asked to stop. None of it is tolerated here regardless of how
technically correct the person doing it happens to be.

## Scope

This applies in issues, pull requests, discussions, commit messages and code
review — anywhere this project is the subject.

## Reporting

Open a
[private security advisory](https://github.com/AKogut/ephemeral-k8s-test-envs/security/advisories/new).
It is meant for vulnerabilities, and it is also the only private channel this
repository has; a report sent there will be read and will not be public. For
anything that does not need to be private, an issue is fine.

Reports are handled by the maintainer, who will read the whole thread before
responding. Possible outcomes are a request to edit a comment, a request to
step away from a thread, or a block. Whichever it is, you will be told which
part of this document it is based on.
