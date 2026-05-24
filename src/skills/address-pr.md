# Address Pull Request Feedback

Two modes depending on intent:

- **Q&A mode**: If the user is asking questions about the PR (what does it do? what changed? why did CI fail?), load context and answer — do not proceed to the implementation loop.
- **Fix mode**: Implement all unresolved review comments by **making code changes, not reporting what needs to change.** For each comment: understand the feedback, make the change (or surface a disagreement), resolve the thread, commit, and push. Triage is a prerequisite to implementation, not the deliverable.

This skill uses scrumlord's own `tasks pr` CLI as the source of truth for combined PR status. `tasks pr` returns a full status report including `reviewComments` (with `allResolved` and an `unresolved[]` list), `continuousIntegration` (`allGreen`, `failed[]`, `pending[]`), `pullRequest` (`mergeable`, `mergeStateStatus`, `state`), and a top-level `readyToMerge` boolean. `tasks pr --comments` lists unresolved review comments (`--comments --all` or `--resolved` for variants). `tasks pr --poll` (or `--watch`) polls until CI/state changes — use it for the bounded-wait combined status during the stabilization loop, and parse its JSON. Thread _resolution_ still uses `gh api graphql` (inlined below).

## Preconditions

Requires a GitHub remote. At startup:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null || { echo "Not a git repository."; exit 1; }
git remote get-url origin 2>/dev/null || { echo "No GitHub remote configured. Run 'gh repo create' first, or use quick-review for local-only feedback."; exit 1; }
gh repo view >/dev/null 2>&1 || { echo "Remote is not a GitHub repository gh can access. Check 'gh auth status'."; exit 1; }
```

## Gotchas

- **Never bail. Loop until the PR is merge-ready.** The only valid exit is `readyToMerge == true`: zero unresolved threads (fresh fetch), every CI check terminal and passing, no review bot still pending, no merge conflict with base, mergeability known. An iteration count is not an exit condition.
- **This skill implements changes, it does not produce reports.** If you finish with a summary of what needs to change but haven't edited any files, you have not done the job. Triage → implement → resolve → commit → push. Every run must end with a commit pushed (or an explicit blocker surfaced to the user), not a plan.
- **Review bots post comments when their CI checks complete.** Cursor Bugbot, CodeRabbit, Copilot, and similar tools run as CI checks. Their check completing IS the event that creates new review comments. You must wait for every check to reach a terminal state before evaluating whether work remains. `tasks pr --poll` waits on this for you; treat checks whose names contain `review`, `copilot`, `coderabbit`, or `bugbot` as review-bot checks.
- **Mergeability must be checked in every stabilization iteration.** A clean merge at preflight does not prove the PR still merges after base-branch movement, force-pushes, or review-bot commits. Read `pullRequest.mergeable` and `mergeStateStatus` from `tasks pr` each iteration.
- **Outdated threads may still apply.** An outdated thread means the diff context changed, not that the issue is resolved. Read the current code before resolving.
- **Thread resolution is hard to undo.** Only resolve threads after local checks pass. If you resolve first and validation fails later, the retry loop has nothing to work with.
- **Sync before triage.** If the branch is behind the base branch, comment line numbers won't match the working tree. Always fetch and sync first.
- **This skill must complete its own stabilization loop within a single turn.** Run the loop inline. Do not rely on a Stop hook to re-invoke you. After the initial fix pass, run the stabilization loop inline until `readyToMerge == true`.

## Workflow

### 1. Resolve the repository and pull request

- Check auth: `gh auth status`. Stop and report if it fails.
- Detect the repo: `gh repo view --json nameWithOwner`.
- Try the current branch's PR first: `gh pr view --repo OWNER/REPO --json number,state,url,title,body,headRefName,baseRefName`.
- Fallback: `gh pr list --repo OWNER/REPO --head $(git branch --show-current) --state open --json number,state,url,title,body,headRefName,baseRefName --limit 1`.
- Explicit PR number: `gh pr view PR_NUMBER --repo OWNER/REPO --json ...`.
- Stop if no open PR can be resolved. Confirm the PR is open — stop if merged or closed.

Store `OWNER`, `REPO`, and `PR_NUMBER` — the stabilization loop needs them.

### 2. Load full PR context

```bash
gh pr view $PR_NUMBER --json number,title,body,baseRefName,headRefName,additions,deletions,changedFiles,author,state,reviewDecision
gh pr diff $PR_NUMBER
gh pr view $PR_NUMBER --comments
tasks pr
```

`tasks pr` gives you the combined status snapshot (review comments, CI, mergeability, `readyToMerge`).

**Q&A mode:** Use this context to answer the user's question, then stop. Do not touch preflight or the stabilization loop.

**Fix mode:** Continue to preflight.

### 3. Capture state and sync

- `git status --short` and `git branch --show-current`.
- `git fetch origin`
- `git merge origin/<baseRefName> --no-edit`
- If the merge conflicts, resolve before any review triage, then `git add` the resolved files and `git commit --no-edit`.

### 4. Verify the push target

Read `headRefName` from the PR. Check `git rev-parse --abbrev-ref @{upstream} 2>/dev/null`. If no upstream exists, or the local branch name differs from the PR head branch, push with `git push -u origin HEAD:refs/heads/<headRefName>`.

### 5. Check CI before review work

Run `tasks pr` and read `continuousIntegration`. If any check is in `failed[]`, inspect the failing run logs with `gh run view RUN_ID --log-failed`, fix CI locally, and re-check before touching review threads.

### 6. Fetch unresolved review threads

```bash
tasks pr --comments
```

This lists the unresolved review comments — use it as the source of truth for thread IDs, file anchors, authors, and outdated state. Use `tasks pr --comments --all` or `tasks pr --resolved` when you need resolved threads too.

### 7. Triage every unresolved thread

Classify each thread before implementing anything:

- **Already addressed**: code already reflects the feedback. Mark for resolution after verification.
- **Needs code**: implement the requested change.
- **Needs only a reply**: post the reply, then resolve when appropriate.
- **Disagree**: implement it anyway. Do not argue with reviewers. Only escalate when the change would likely cause a regression, conflicts with another thread, or requires a materially broader refactor.

Track work with `tasks progress add current --message "..."`. Begin implementing immediately after triage — triage without implementation is not useful.

### 8. Implement and verify

For each task:

1. Read the file(s) to understand current state.
2. Implement the requested change.
3. Apply suggestion blocks exactly unless they would break the code; adapt conservatively if needed.
4. Run project-local verification after each change cluster.
5. Keep changes directly traceable to review feedback.

### 9. Commit, push, and resolve

```bash
git add <specific files>
git commit -m "Address review feedback on #$PR_NUMBER"
git push origin HEAD:refs/heads/<headRefName>
```

Resolve addressed threads only after local verification passes and the push succeeds. Resolve each thread with the GraphQL mutation below, using the thread ID from `tasks pr --comments`:

```bash
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}' -f threadId="$THREAD_ID"
```

### 10. Run the stabilization loop

After committing and pushing, every push triggers review bots to re-review. **Never trust a zero-unresolved count taken immediately after pushing.** The bot hasn't reviewed the new code yet.

Run this loop inline, within the same turn, until `readyToMerge == true`. There is no iteration cap — loop as many times as needed.

Run `tasks pr --poll` at the top of each iteration:

```bash
tasks pr --poll
```

This polls until CI/state changes, then returns the combined JSON status: `reviewComments` (`allResolved`, `unresolved[]`), `continuousIntegration` (`allGreen`, `failed[]`, `pending[]`), `pullRequest` (`mergeable`, `mergeStateStatus`, `state`), and the top-level `readyToMerge` flag.

For each iteration:

1. `git fetch origin` so base-branch movement is visible.
2. Run `tasks pr --poll`.
3. If `pullRequest.mergeable` reports a merge conflict: resolve it immediately (`git merge origin/<baseRefName> --no-edit`, fix, verify, commit, push). Merge conflicts outrank thread work.
4. If `continuousIntegration.failed[]` is non-empty: fix CI next (`gh run view RUN_ID --log-failed`, fix locally, verify, commit, push).
5. If `reviewComments.unresolved[]` has actionable threads: implement fixes, verify, commit, push, resolve threads via the GraphQL mutation above.
6. If no code action is needed but CI is still pending or mergeability is unknown: continue to the next iteration.
7. Exit only when `readyToMerge == true` AND no commit was pushed in the current iteration.

Every 3 iterations: do a root-cause reflection. Is there a pattern across failures? Are you fixing your own fixes? Would one structural change resolve multiple issues?

### 11. Report out

When `readyToMerge == true`, output:

- Changes made, files touched, commits pushed
- Threads resolved
- CI status at final check

Then output the completion promise:

```
<promise>PR feedback addressed and CI passing</promise>
```

## Comment handling rules

- **Suggestions** (` ```suggestion ` blocks): apply exactly unless unsafe, then adapt conservatively.
- **Nitpicks and style feedback**: implement them unless they conflict with stronger repository conventions.
- **Reviewer questions**: reply directly when no code change is needed.
- **Outdated threads**: inspect current code before resolving.
- **Duplicate feedback**: fix once, then resolve each satisfied thread.
- **Conflicting reviewer guidance**: surface the conflict and propose the safest resolution path.

## Subagent worktree awareness

When invoked by a subagent in a git worktree: git commands work normally. Worktree branch names may differ from the PR head branch — always use `gh pr view PR_NUMBER --json headRefName -q .headRefName` to get the correct branch. Push to the correct branch: `git push origin HEAD:refs/heads/$(gh pr view $PR_NUMBER --json headRefName -q .headRefName)`.

## Safety boundaries

- Do not change dependencies or config files unless a review comment explicitly requires it.
- Do not reformat unrelated files or expand scope.
- Do not resolve threads until local checks pass and changes are committed.
- Do not force-push unless the user explicitly asks.

## Stop conditions

Stop and inform the user if:

- Not a git repository or no GitHub remote configured (see Preconditions).
- `gh auth status` fails.
- No PR can be identified for the current branch.
- The PR is not open (merged, closed, or draft-blocked).
- Push access is unavailable.
- Reviewer requests are mutually incompatible and no safe default exists.
