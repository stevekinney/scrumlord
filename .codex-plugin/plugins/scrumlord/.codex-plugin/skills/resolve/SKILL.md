---
name: resolve
description: Drive a task's pull request to merge-ready via the address-pr loop (unresolved comments, conflicts, failing CI), then complete the task. With --all, merge ready PRs and fan out to resolve the rest. Trigger on "resolve the PR".
---

Drive a task's pull request to merge-ready and complete the task. Where `next` stops at `in-review` with an open PR, `resolve` picks it up from there: it stabilizes the PR — resolving review comments, fixing CI, clearing merge conflicts — until it is merge-ready, then completes the task once merged.

This skill leans on scrumlord's own `tasks pr` CLI for combined PR status and the `address-pr` skill for the per-PR stabilization loop. The cardinal rule comes from `address-pr`: **never bail — loop until the PR is merge-ready.** An iteration count is not an exit condition; `readyToMerge == true` is.

## Preconditions

- The `tasks` CLI is on PATH with an initialized `tmp/tasks.db`.
- A GitHub remote is configured and `gh` is authenticated. If `tasks pr` fails with `gh_not_found`, install the GitHub CLI and surface the error.

## Single mode (default)

Operate on the current task's PR.

### 1. Load PR status

```bash
tasks pr
```

Read the combined status: `readyToMerge`, `reviewComments` (`allResolved`, `unresolved[]`), `continuousIntegration` (`allGreen`, `failed[]`, `pending[]`), and `pullRequest` (`mergeable`, `mergeStateStatus`, `state`). If no PR can be resolved, stop and report — run `next` to open one first.

### 2. Stabilize via address-pr

If `readyToMerge` is already `true`, skip to Step 3. Otherwise — when there are unresolved review comments, a merge conflict with `origin/main`, or failing/pending CI — invoke the `address-pr` skill on this PR. That skill runs its own stabilization loop inline: it implements review feedback (it does not merely report it), resolves threads, fixes CI, re-syncs against the base branch, and re-loops whenever a review bot posts new comments after a check completes. It exits only when `readyToMerge == true`.

Do not short-circuit `address-pr` with a zero-unresolved count taken immediately after a push — review bots re-review on every push. Let `address-pr` own that loop; treat its merge-ready signal as authoritative.

### 3. Merge and complete

Once the PR is merge-ready, merge it (`tasks complete --sync --apply` squash-merges ready PRs and completes their tasks in one pass, or merge through your normal flow). When the PR is merged into `origin/main`, complete the task and record it:

```bash
tasks update current --status completed
tasks progress add current --message "PR #<number> merged into main; task completed"
```

Never leave a finished task in `in-review` — the final action is always `--status completed`.

## --all mode

Read this as "merge the ready PRs, then resolve the not-ready ones."

### 1. Merge everything already ready

First sweep all open PRs for ones that are already merge-ready (CI green, no unresolved comments, no conflicts) and merge them. `tasks complete --sync` reports the ready set read-only; add `--apply` to squash-merge each ready PR and complete its task, and `--all` to also merge ready PRs that have no associated task:

```bash
tasks complete --sync             # dry-run: see what's ready
tasks complete --sync --apply     # merge ready PRs, complete their tasks
tasks complete --sync --apply --all
```

Use `tasks overview` to inspect every open PR's CI status, unresolved comment counts, and merge-conflict state before and after the sweep.

### 2. Fan out resolve on the not-ready PRs

For each PR that is **not** merge-ready, dispatch a subagent (via the `Agent` tool) to run the single-mode `resolve` flow on that PR — which means invoking `address-pr` to stabilize it, then merging and completing once `readyToMerge`. Concurrency-cap the fan-out: default **3**, range `1..5`, hard-cap at 5. Dispatch one subagent per PR in a batch in a **single message** so they run in parallel; wait for the batch to return before the next.

Each subagent's prompt must name the PR (number and head branch), state that it owns the full stabilize-to-merge loop via `address-pr`, and require a structured return: `{ prNumber, taskId, outcome: "merged" | "stuck", notes }`. A subagent that cannot reach merge-ready returns `stuck` with the blocker — it does not silently give up, but it also does not loop forever on a blocker that needs a human (mutually incompatible reviewer requests, missing push access).

### 3. Final report

Bucket the results: **Merged** (ready-and-merged plus subagent-merged), **Stuck** (surfaced blocker, needs attention). Include PR number, task id, and the blocker for each stuck PR.

## Gotchas

- **Never bail. Loop until merge-ready.** The only valid single-PR exit is `readyToMerge == true` then merged. Borrow `address-pr`'s ethos: zero unresolved threads (fresh fetch), every CI check terminal and passing, no review bot still pending, no merge conflict, mergeability known.
- **Mergeability must be re-checked, not assumed.** A clean merge at the start does not survive base-branch movement or new bot commits. `tasks pr` reports `mergeable` and `mergeStateStatus` each call.
- **Use `tasks pr --poll` for bounded waits** on CI and bot reviews instead of hand-rolling a `tasks pr` loop.
- **The CLI is the merge authority.** Prefer `tasks complete --sync --apply` over `gh pr merge` so task completion stays coupled to the merge.
- **Always finish with `tasks update current --status completed`** (or `tasks complete <id>`). A merged PR whose task is still `in-review` is an unfinished run.
- **Subagents in `--all` mode own their own merge loop** but escalate genuine human-needed blockers as `stuck` rather than spinning.

## Done criteria

- **Single mode**: the current task's PR is merged into `origin/main` and the task is `completed`.
- **--all mode**: every already-ready PR was merged and its task completed, every not-ready PR was driven to merge-ready and merged (or surfaced as `stuck`), and the final report bucketed every PR as Merged or Stuck.
