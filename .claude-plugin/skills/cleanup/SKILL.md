---
description: Remove git worktrees for completed tasks whose pull requests have merged, skipping anything still in flight or with uncommitted changes. Trigger on "clean up worktrees" or "tasks cleanup --worktrees".
---

# Clean Up Worktrees For Completed Tasks

Per-task worktrees pile up. Every task that runs through the agent lifecycle materializes a worktree under `tmp/worktrees/tasks/<short-id>` on a `tasks/<short-id>` branch, and once its pull request merges and the task is `completed`, that worktree is dead weight — it holds a checkout of work that already landed on `main`. This skill removes the worktrees that are safe to remove and leaves everything else exactly where it is.

The governing rule: **never remove a worktree with uncommitted or unpushed changes, and never remove one before confirming the task is `completed` AND its PR is merged.** A worktree is the only copy of work that has not been pushed. Deleting it can destroy work that no task or PR remembers. When in doubt, skip and warn.

## Step 1: Enumerate task worktrees

```bash
git worktree list --porcelain
```

This lists every worktree with its path, `HEAD`, and branch. Filter to task worktrees by the convention: their path is under `tmp/worktrees/tasks/<short-id>` on a `tasks/<short-id>` branch. The short-id is a hash, not the task ID — connect a worktree back to its task through its **branch**, not by parsing the directory name.

## Step 2: Resolve each worktree's task and decide

For each task worktree, resolve the owning task from its branch, then read the task and its PR state:

```bash
tasks with-branch <branch>   # the worktree's tasks/<short-id> branch → owning task
tasks get <task-id>
```

A worktree is **safe to remove** only when both are true:

- The task status is `completed`.
- Its pull request is **merged** (`tasks get` reflects the lifecycle; confirm with `gh pr list --state merged --head <branch> --json number,mergedAt` or `tasks with-branch <branch>` if you need to be sure the branch's PR actually landed).

If either is not true, the worktree stays. A `completed` task whose PR somehow is not merged is a contradiction worth surfacing, not a green light to delete.

## Step 3: Refuse to remove dirty or unpushed worktrees

Even when the task is completed and merged, check the worktree itself before touching it. A worktree can hold local edits that never made it into the merged PR:

```bash
git -C <worktree-path> status --short
git -C <worktree-path> log --oneline @{upstream}.. 2>/dev/null
```

If `status --short` shows **uncommitted changes**, or the log shows **commits ahead of upstream** (unpushed work), do **not** remove the worktree. Warn instead, naming the path and what it is holding, so the user can rescue the work. This guard outranks the completed-and-merged signal: a merged task does not justify discarding uncommitted local work.

## Step 4: Remove the safe worktrees

For each worktree that is completed, merged, and clean:

```bash
git worktree remove <worktree-path>
```

If the branch is fully merged into `main` and no longer needed, prune it too:

```bash
git branch -d <branch>
```

Use `-d` (safe delete — refuses if the branch is not merged), never `-D` (force). If `-d` refuses, the branch is not actually merged where Git can see it — treat that as a signal to skip, not to force.

## Step 5: Prune stale administrative entries

After removing worktrees, clear out stale bookkeeping for directories that are already gone:

```bash
git worktree prune
```

This only removes administrative entries for worktrees whose directories no longer exist — it never deletes a live worktree, so it is safe to run unconditionally at the end.

## Step 6: Report

Summarize:

- **Removed** — each worktree path, its task ID, and the branch (and whether the branch was pruned).
- **Skipped** — each worktree left in place, with the reason: task not yet `completed`, PR not merged, uncommitted changes, or unpushed commits. For the dirty/unpushed cases, make the warning loud — that is work at risk.

## Gotcha

The two guards are not interchangeable. The lifecycle guard (completed + merged) protects against removing a worktree whose work is still in flight. The cleanliness guard (no uncommitted, no unpushed changes) protects against removing local work that never made it into the PR at all — which can happen even on a "completed" task. Both must pass. If either fails, skip and warn. Use `git worktree remove` (which itself refuses to remove a dirty worktree without `--force` — and you should never pass `--force` here) and `git branch -d`, never their forcing variants.
