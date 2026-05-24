# Merge All Ready Pull Requests

This skill clears the merge queue. It finds every open pull request that is genuinely ready — review threads resolved, CI green, no merge conflict — fans out one subagent per ready PR to merge it, and completes the associated task. Pull requests that are _not_ ready are not this skill's problem: they belong to `resolve`, which drives a PR to merge-ready by addressing feedback and waiting on CI. Merge only merges.

The governing rule: **only merge genuinely ready PRs.** Never force-merge past failing CI, never merge over unresolved review threads, never override a merge conflict. The whole value of this skill is that it is conservative — it merges exactly the work that the project has already blessed.

## Step 1: Identify ready pull requests

The fastest path, when it is available, is the CLI's own merge-queue report:

```bash
tasks complete --sync
```

`tasks complete --sync` is read-only and dry-run by default: it reports which open pull requests are ready to merge (CI green, no unresolved comments, no conflict) and which tasks they would complete. That report is your candidate list.

To build the list by hand instead, enumerate open PRs and check each one's readiness:

```bash
gh pr list --state open --json number,headRefName,isDraft,title,url
```

For each task in `in-review`, or for each open PR's branch, read the combined readiness report and trust the top-level flag:

```bash
tasks pr   # for the current branch; or resolve the task by branch first
```

A PR is **ready** only when `readyToMerge` is `true`: `reviewComments.unresolved` is empty, `continuousIntegration.failed` and `.pending` are empty, and `pullRequest.mergeable` reports no conflict. A draft PR is never ready. Anything short of `readyToMerge == true` goes on the skip list, not the merge list.

## Step 2: Determine the merge method

Do not assume `--squash`. Check what the repository actually allows before merging:

```bash
gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed
```

Pick the method the repo enables, preferring the project's convention (squash is the common default for this project — `tasks complete --sync --apply` squash-merges). If only one method is allowed, use it. Use this same method consistently across the fan-out.

## Step 3: Fan out and merge

If you took the CLI path and the dry-run report looks right, the simplest correct action is to let the CLI do the whole pass atomically:

```bash
tasks complete --sync --apply
```

This squash-merges each ready PR and completes its task in one pass, and exits non-zero if any merge or completion fails. Add `--all` only when you also want to merge ready PRs that have _no_ associated task. Prefer this when it applies — it is the merge authority and it keeps task completion coupled to the merge.

When you need per-PR control (mixed merge methods, selective merging, custom progress notes), fan out instead. Dispatch one subagent per ready PR, **all in a single message**, capped at a sane concurrency (a handful at a time — do not launch dozens of merges simultaneously against the same base branch, since each merge moves `main` and can invalidate the others' mergeability). Each subagent:

1. Re-confirms readiness right before merging (`tasks pr` for that PR's branch) — state can change between Step 1 and the merge.
2. Merges with the method from Step 2: `gh pr merge <number> --squash` (or `--merge` / `--rebase` per the repo).
3. Completes the task: `tasks complete <id>` (or `tasks update <id> --status completed`).
4. Records a progress note: `tasks progress add <id> --message "Merged PR #<n> into main"`.

A subagent that finds its PR is no longer ready at the re-confirm step must **abort the merge** and report the reason, not force it.

## Step 4: Leave the not-ready PRs alone

Pull requests that failed the readiness check in Step 1 are out of scope here. Do not touch them. Getting a stuck PR to ready — addressing review feedback, fixing CI, resolving conflicts — is exactly what `resolve` does. Note each skipped PR with its blocking reason so the user knows what `resolve` needs to pick up next.

## Step 5: Report

Summarize:

- **Merged** — each PR number, its branch, and the task it completed.
- **Skipped (not ready)** — each open PR you did not merge, with the specific blocker: unresolved threads, failing or pending CI, draft status, or a merge conflict. This is the to-do list for `resolve`.
- **Failures** — any merge or completion that errored (the `--apply` path exits non-zero on failure; a fanned-out subagent should report its own failure), with the error so the user can act.

## Gotcha

Readiness is checked twice, on purpose: once to build the candidate list, once again immediately before each merge. Between those two moments, another merge can move `main` and turn a green PR red, or a review bot can post a new comment. Trust the re-confirm, not the candidate list. And never force-merge — if a PR is not `readyToMerge`, it is `resolve`'s job, not yours.
