---
description: 'Reconcile task statuses with reality: fast-forward main, infer in-progress/in-review/completed from open PRs, worktrees, and merged diffs, create follow-up tasks for partially-completed work, and repair the dependency graph. Trigger on "sync the tasks".'
---

# Sync Task Statuses With Reality

This skill reconciles the local task graph against what actually happened: which branches have open pull requests, which worktrees are live, which work has already landed on `main`. Tasks drift out of sync whenever work happens outside the `tasks` lifecycle — a PR merges without `tasks complete`, a worktree gets abandoned, a dependency is discovered mid-implementation but never wired into the graph. This skill walks the evidence and repairs the graph so the task statuses mean something again.

The governing rule: **every status change here must be evidence-based.** PR state, worktree presence, and merged diffs are evidence. A hunch is not. When you change a task's status, record a progress note explaining the evidence that justified it.

## Step 1: Sync `main` safely

You want local `main` to match `origin/main` before judging what has landed.

```bash
git fetch origin
git rev-parse --abbrev-ref HEAD
git status --short
```

Fast-forward `main` only when it is safe:

- If the current branch is **not** `main`, do not switch and pull blindly. Fetch is enough — compare against `origin/main` directly (`git log --oneline main..origin/main`) and note that you left the working branch untouched.
- If the working tree is **dirty**, do not touch the branch. Note the dirty state in the report and proceed with `origin/main` as your reference point.
- If you are on a clean `main`, fast-forward: `git merge --ff-only origin/main`. If the fast-forward is rejected, `main` has diverged — report that and stop touching the branch rather than forcing it.

From here on, treat `origin/main` as ground truth for "what has landed."

## Step 2: Reconcile statuses against open pull requests

```bash
gh pr list --state open --json number,headRefName,isDraft,title,url
```

For each open PR, find the task whose branch matches the PR head (`tasks with-branch <headRefName>`):

- PR is **open and not a draft**: the task should be `in-review`. If it is currently `in-progress` or earlier, move it: `tasks update <id> --status in-review`.
- PR is a **draft**: the task should be `in-progress`, not `in-review`. A draft PR is work-in-progress, not work-awaiting-review.

Prefer `tasks pr --sync` when it is available — it pulls GitHub state and applies the in-review transition for the current branch's PR for you. Use the manual mapping above for tasks that are not on the current branch.

## Step 3: Reconcile against live worktrees

```bash
git worktree list --porcelain
```

Task worktrees live at `tmp/worktrees/tasks/<task-id>`. For each worktree under that path, resolve the task (`tasks get <id>`):

- Worktree exists, branch exists, but **no open or merged PR** for that branch: the task is genuinely `in-progress`. If it is sitting in `draft` or `ready`, move it to `in-progress`.
- Worktree exists but the task already shows `in-review` or `completed` (it has a PR): leave the status as the PR evidence dictates — the worktree alone does not downgrade it.

A live worktree with no PR is the signal that work has started but not yet been published for review.

## Step 4: Reconcile against recently merged pull requests

```bash
gh pr list --state merged --limit 30 --json number,headRefName,title,mergedAt,url
```

For each merged PR, find the matching task. Before completing it, verify the work actually landed (Step 5 covers partial cases). When the merged diff fully delivers the task's described scope:

```bash
tasks complete <id>
```

`tasks complete` accepts several IDs at once and leaves already-completed tasks untouched, so it is safe to batch the genuinely-done ones.

## Step 5: Partial-completion detection

A merged PR does not always finish the task it was attached to. Before marking anything `completed`, compare the **task's described scope** (read it: `tasks get <id>`, and read its plan file if it has one) against **what the merged diff actually delivered** (`gh pr view <number> --json title,body` and `gh pr diff <number>`).

Judge "partial" concretely:

- The task description lists three deliverables; the diff implements two. Partial.
- The task says "add the endpoint and tests"; the diff adds the endpoint with no tests. Partial.
- The PR body itself says "follow-up to come" or "deferring X to a later PR." Partial — and the PR author told you what is missing.

When a task is only partially delivered, **do not complete it.** Instead:

1. Create a follow-up task capturing exactly the remaining work, with enough detail to action later: `tasks create --title "<remaining work>" --description "Remaining from <original-id> / PR #<n>: <what is still missing>" --priority <1-3>`.
2. Link it where a dependency genuinely exists: `tasks blockers add <follow-up-id> <prerequisite-id>`.
3. Decide the original task's fate on evidence: if the merged slice is a coherent, shippable unit and the follow-up captures the rest, complete the original and let the follow-up carry the remainder. If the merge left the original's core deliverable unfinished, keep the original `in-progress` and record why.

Record a progress note on whichever task you touched, naming the PR and the gap you found.

## Step 6: Dependency-graph sweep

Walk the graph and verify blocker edges reflect reality.

```bash
tasks list
```

For each task, read its description for dependency language — "depends on", "blocked by", "once ... exists", "after we ship", "prerequisite", "gated on". When a task carries that language but has no corresponding blocker edge, the graph is lying. Verify the current wiring with `tasks blocked-by <id>` (what blocks this task) and `tasks blocking <id>` (what this task blocks), then repair:

```bash
tasks blockers add <blocked-id> <blocker-id>
```

Conversely, if a blocker edge points at an already-`completed` task, that edge is satisfied and no longer constrains the dependent — note it, but the CLI's computed `blocked` field already accounts for blocker status, so you usually do not need to remove it.

## Step 7: Report what changed

Summarize, grouped:

- **Status transitions applied**, each with the evidence (PR #, worktree path, or merged diff) that justified it.
- **Follow-up tasks created** for partial completions, with the gap each one captures and any blocker edge added.
- **Dependency edges added** during the graph sweep.
- **Anything left deliberately untouched** — a dirty working tree that blocked the `main` fast-forward, a diverged branch, an ambiguous partial-completion you want the user to adjudicate.

If nothing needed to change, say so explicitly so the user knows the graph was checked, not skipped.

## Gotcha

Never guess a status. If you cannot point to a PR state, a worktree, or a merged diff, do not change the task — surface the uncertainty in the report and let the user decide. And every status change gets a progress note (`tasks progress add <id> --message "..."`) recording the evidence, so the next sync has a trail to follow.
