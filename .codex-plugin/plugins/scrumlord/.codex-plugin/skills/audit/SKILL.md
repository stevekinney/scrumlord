---
name: audit
description: Review recently completed tasks, sessions, and PRs for uncaptured work, run the validation scripts, and file tasks for pre-existing issues. Trigger on "audit the tasks" or "audit the backlog".
---

# Audit For Uncaptured Work And Pre-Existing Issues

This skill hunts for work that exists but is not on the board. Two sources feed it: work that was _discussed_ — a TODO dropped in a PR, a follow-up promised in a review thread, scope explicitly deferred — but never written down as a task; and work the _codebase itself_ is telling you about — lint warnings, failing tests, type errors that predate the current change. Both kinds of work are real. Neither shows up in `tasks list` until you put it there. This skill finds them and files tasks, so the backlog reflects what actually needs doing.

The deliverable is **new tasks with enough detail to action later**, plus a report explaining why each one exists. Audit does not fix anything — it captures.

## Step 1: Mine recently completed work for uncaptured follow-ups

```bash
tasks completed
```

For each recently completed task, read its trail and its pull request:

```bash
tasks get <id>
tasks session <id>
tasks progress list <id> --full
gh pr view <pr-number> --comments
```

You are looking for work that was _implied but never captured_:

- **TODOs introduced** in the merged code — a `// TODO:` or `// FIXME:` that the PR added and nobody filed a task for.
- **Follow-ups mentioned in PR threads** — "good catch, let's handle that in a follow-up," "out of scope for this PR," "we should revisit this."
- **Scope explicitly deferred** in the PR body or progress notes — "deferring the migration to a separate change," "tests for the edge case to come."

Each of these is a candidate task. Before filing, **check whether it already exists** (Step 3 covers de-duplication). When it is genuinely uncaptured, create it:

```bash
tasks create --title "<the deferred work>" --description "Surfaced during audit of <completed-id> / PR #<n>: <what was deferred and the exact context>" --priority <1-3>
```

Link it when a real dependency exists — for example, when the follow-up cannot start until another in-flight task lands: `tasks blockers add <new-id> <prerequisite-id>`.

## Step 2: Run the project validation scripts and capture pre-existing failures

Run the project's own quality gates and watch for problems that are **not** introduced by current work — failures and warnings that are already sitting in the tree:

```bash
bun run lint
bun run format:check
bun run test
bun run typecheck
```

For every pre-existing failure or warning, create a task with enough detail to action it cold later — the failing file, the rule or check name, the test that fails, the exact message:

```bash
tasks create --title "Fix <rule/check>: <file>" --description "Pre-existing <lint|format|test|type> failure surfaced during audit. <file:line> — <rule or test name> — <verbatim message>. Reproduce with: <command>." --priority <1-3>
```

Group related failures sensibly. A single lint rule firing across twelve files is one task ("enable/clean up `<rule>` across the repo"), not twelve. A single failing test suite is one task. Do not shard a coherent cleanup into noise.

## Step 3: De-duplicate before filing

Pre-existing issues are easy to file twice — audit runs repeatedly, and the same warning surfaces every time. Before creating any task, check whether it already exists:

```bash
tasks list
tasks search "<the rule, file, or distinctive phrase>"
```

If a task already covers the issue, do not file a duplicate. If an existing task is close but stale (the file moved, the scope changed), note it in the report rather than creating a near-twin.

## Step 4: Distinguish pre-existing from transient

Not every red test is a real, durable issue. Before filing a task off a failure, make sure it is **pre-existing and reproducible**, not transient:

- A flaky test that passes on re-run is a different problem than a consistently failing one — flag flakiness as its own task ("investigate flaky `<test>`"), do not file it as a hard failure.
- A failure that only appears because the working tree is dirty or mid-edit is not pre-existing — it is the current change. Note it and move on.
- A network-dependent or environment-dependent failure (missing credential, offline service) is environmental, not a code defect — say so rather than filing a code task.

When in doubt, re-run the failing command once to confirm the failure is stable before filing.

## Step 5: Report

Summarize the new tasks created, in two groups, each with a rationale:

- **Uncaptured work** — the deferred follow-ups and TODOs you found, each tied to the completed task or PR thread it came from, with any blocker edge you added.
- **Pre-existing issues** — the lint/format/test/type failures you filed, each with the file, rule, and reproduction command.

Then note anything you deliberately did **not** file — duplicates you found, transient or environmental failures you judged out of scope — so the user can see the audit considered them rather than missing them.

## Gotcha

Audit captures; it does not fix. Resist the urge to "just clean up" a warning while you are here — that turns an audit into an untracked change. File the task, keep the working tree clean, and let `next` or `resolve` pick the work up through the normal lifecycle. And always de-duplicate first: a backlog full of repeated "fix the same lint rule" tasks is worse than no audit at all.
