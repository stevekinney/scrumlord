---
description: Work the next available task end-to-end from inside its worktree: plan it (gated by plan-review) if unplanned, implement it, and open a pull request via committee-review, leaving the task in-review. Trigger on "work the next task" or "tasks next".
---

Work the next task from claim to open pull request. The `tasks next --start` command already did the hard part before you arrived: it claimed the next ready task and materialized a worktree at `tmp/worktrees/tasks/<short-id>` on a `tasks/<short-id>` branch. You are picking up from inside that worktree, on the task's branch, with the task already moved to `in-progress`. Your job is to plan it (if it has no plan), build it, and shepherd it through `committee-review` until a pull request is open and the task is `in-review`.

This is the plugin's end-to-end task workflow. Driving the open PR all the way to merged is the `resolve` skill's job — this skill stops at `in-review`. The caller can chain `resolve` afterward to finish, and you should say so when you hand off.

## Preconditions

- The `tasks` CLI is on PATH and `tmp/tasks.db` exists. If something looks wrong, run `tasks setup status` and surface the result — do not invent a task queue.
- A GitHub remote is configured (`git remote get-url origin`). Steps 1–4 work without a remote, but Step 5 (the `committee-review` PR finale) needs one. If no remote exists when you reach Step 5, record progress and halt: `tasks progress add current --message "Implementation complete; no GitHub remote — halting before PR creation"`. The task stays `in-progress`; resume after `gh repo create`.

## Step 1: Confirm the current task

```bash
tasks current
```

Parse the JSON. Confirm the task is `in-progress` and has a `branch`. This is the task `tasks next --start` claimed — adopt its `id` as `$TASK_ID` for the rest of the run. If `tasks current` returns nothing or errors with `current_task_ambiguous`, inspect `tasks with-branch "$(git branch --show-current)"` and choose explicitly before continuing.

Record a checkpoint so a resuming agent knows where you started:

```bash
tasks progress add current --message "Resumed task in worktree on $(git branch --show-current)"
```

Read prior progress in case a previous agent already did part of the work:

```bash
tasks progress list current --full
```

Pick up from the most recent entry rather than redoing finished steps.

## Step 2: Plan if the task has no plan

Read the task's `plan` field:

```bash
tasks get "$TASK_ID"
```

If `plan` is `null`, the task needs a plan. Enter plan mode and:

- Read every file the task touches. Do not guess at interfaces. Read related task descriptions for context (`tasks blocking` and `tasks blocked-by`) when the task sits inside a dependency chain.
- Draft the plan to `tmp/plans/<task-id>.md` (create the directory if needed).
- Invoke the `plan-review` skill on the drafted plan and drive it to approval. `plan-review` runs an adversarial Codex loop and emits an approval signal when the plan is ready. If it raises findings, address them (accept-and-edit or rebut) until it approves.
- Only after `plan-review` approves, register the plan on the task:

```bash
tasks update "$TASK_ID" --plan tmp/plans/<task-id>.md
tasks progress add current --message "Plan approved by plan-review at tmp/plans/$TASK_ID.md"
```

## Step 3: Read the existing plan

If `plan` is already set, read that plan file before doing anything else. If it points to a missing file, treat the plan as absent and fall back to Step 2. Do not implement against a plan you have not read.

## Step 4: Implement

Follow the plan. Standard rules apply:

- Match existing codebase conventions. Do not introduce new patterns without cause.
- Write tests alongside the implementation, not after.
- Fix pre-existing warnings and test failures in any file you touch.
- Run the project's lint, test, and typecheck commands and clear them before moving on.
- Commit in logical chunks. Never use `--no-verify` or otherwise skip hooks.

If you discover the plan was wrong, update the plan file in place (replace, don't append), then continue. Do not silently diverge from the recorded plan.

Record a progress entry at every meaningful checkpoint:

```bash
tasks progress add current --message "Implemented X in <files>; tests green"
```

Keep entries short and factual. Reference file paths and commit SHAs so a resuming agent can verify state from Git rather than trusting prose.

## Step 5: Open the PR via committee-review

When implementation is complete and local checks are green, invoke the `committee-review` skill. That skill gates PR creation behind a multi-agent plus Codex review loop and opens the PR itself once consensus is reached. **Do not run `gh pr create` directly** — a PreToolUse hook will block it, and the committee approval marker has to exist first anyway.

When `committee-review` returns with a PR URL, move the task to `in-review` and record it:

```bash
tasks update "$TASK_ID" --status in-review
tasks progress add current --message "Opened PR #<number>: <url>"
```

## Gotchas

- **Never run `gh pr create` directly.** Always go through `committee-review`. The hook blocks direct attempts; do not try to sidestep it.
- **Never skip hooks** (`--no-verify`, `--no-gpg-sign`, etc.) at any point.
- **One task per invocation.** Do not auto-pop the next task after this one reaches `in-review`. If the user wants another, they will say so.
- **If `committee-review` or `plan-review` surface a blocker that needs user input**, stop and report. Do not invent answers — update the task with a progress note so the queue reflects reality.
- **If the task description is ambiguous**, ask one targeted question before planning. Re-planning later is more expensive than discovering the goal was wrong after committee-review.
- **If CI is broken on the base branch** before you start, surface it. Don't fight a broken baseline.

## Done criteria

A run is complete when the task is `in-review` with an open PR, in order:

1. `tasks current` produced an `in-progress` task with a branch.
2. The task has an approved plan registered (drafted and approved by `plan-review`, or pre-existing and read).
3. Implementation passed local lint, test, and typecheck.
4. `committee-review` opened a PR.
5. The task was moved to `in-review` and the PR number recorded.

Stopping short of `in-review` is an in-flight run, not a done one. Once you reach `in-review`, hand off: tell the caller they can chain the `resolve` skill to drive the PR to merge and complete the task.
