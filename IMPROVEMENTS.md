# scrumlord `tasks pipeline` — improvements log

Captured while watching `cinder/scripts/next.ts` drive a real task end-to-end.
Each entry: what cinder does → what scrumlord does (or doesn't) → improvement.

## Improvements

### 1. Validate the agent CLI before claiming a task

**Cinder:** First line of output is `Validating claude -p invocation (cheap smoke test)…` followed by `claude -p is reachable`. If `claude` isn't on `$PATH` or the binary is broken, the pipeline fails fast _before_ mutating any task state.

**Scrumlord:** Capability precheck only confirms `--worktree` / `--cd` flag support — it does not actually invoke the binary. A broken or missing `claude` only surfaces after `claimNext` has moved the row to `in-progress`.

**Action:** Add a `claude -p <<<"smoke test, reply OK"` (and equivalent `codex exec "reply OK"`) pre-check at the start of `runPipeline`, before `acquirePipelineLock`. Cache the result per run id so it does not re-run per task.

### 2. Echo the resolved task title at the top of every task

**Cinder:** Emits `[TASK] Task 0a423b46: Add confirm-dialog.svelte (destructive-action confirmation)` as the first line for each task — short id, colon, full title.

**Scrumlord:** Logs `claimed: <title>` and the short id as a separate prefix, but the title is not embedded in the per-task glyph line. Means when grep-ing the log later you cannot find "what was task `0a423b46` doing" without joining lines.

**Action:** Include the title verbatim in the claim line and again at every phase-step log so each line is independently meaningful.

### 3. Surface the plan path immediately

**Cinder:** `[OK] Plan exists at tmp/plans/0a423b46-…md` — tells the operator (and the agent) where the plan lives before spawning anything. If no plan exists, cinder drafts one inline using `claude -p` with a plan prompt and writes it to `tmp/plans/<id>.md` _before_ the implementation phase.

**Scrumlord:** Has `tasks set-plan` and reads `task.plan` but the pipeline never logs the plan path and never drafts one if missing. It just spawns the agent and hopes the skill handles planning. The `next-task` skill _does_ draft plans, but the pipeline doesn't surface that fact, so silence after spawn looks like a hang.

**Action:** In `runOneTask`, log `plan: <path>` (or `plan: none — agent will draft`) right after `claimed`. Consider an explicit `ensurePlan` phase that drafts via `claude -p` directly when `task.plan` is missing — keeps the heavy implementation prompt focused on implementation and gives the operator a visible plan-mode step.

### (verified) The user's actual scenario — queue was empty

**Inspected scrumlord's own queue:** `tasks available --count` → `0`, `tasks remaining` → `0`, `tasks next` → empty. There were no ready tasks for the pipeline to claim. Running it in this state produces the correct behavior:

```
━━━ tasks pipeline ━━━ run=… mode=drain cli=claude
· queue empty; nothing to drain
━━━ summary ━━━ shipped 0  skipped 0  failed 0  (0s)  exit=0
```

That output is correct but is _easy to miss_ in a terminal: three short lines flash by, no agent spawns, exit code 0. "Didn't do anything" is a fair description from the user side.

**Action:**

- When the queue is empty, surface _why_ explicitly with a queue breakdown: `queue: 0 ready, X blocked, Y in-progress, Z draft`. The user can then act on the right thing (unblock something, mark a draft ready, etc.).
- When `attempts === 0` and exit is 0, exit with a non-error but distinct visual signal — a yellow `nothing to do` summary line rather than the all-zero green summary, which currently looks identical to "queue drained successfully."

### (would-have-mattered) Other plausible failure modes

Before any of the polish items below: the user reported running `tasks pipeline` and watching it "not do anything." Likely culprits to verify in code, in priority order:

1. **No agent CLI smoke test.** If `claude` isn't on `$PATH` for the spawned process (Homebrew shim, fnm/nvm shadow, etc.), `Bun.spawn(['claude', …])` rejects immediately and we record `agent_failed` but the exit happens in milliseconds — looks like "did nothing" because the work was over before stderr flushed.
2. **`claimNext` succeeded but spawn race.** Check that the lockfile got written and a `pipeline:phase=claim` marker exists for whichever task moved to in-progress. If yes, the agent died; if no, no task was ever picked up — meaning the queue was empty (no `ready` tasks with satisfied blockers) and we silently exited.
3. **`--cli` / `SCRUMLORD_CLI` missing.** The CLI wrapper throws `scrumlord_cli_required` before any logging starts. Exit code 2, no banner. The banner should print even on flag-validation failure so the user sees _something_ attempted.

**Action:** Make the banner the very first stderr line, before flag validation. Add the smoke test (item 1 above). When `claimNext` returns null, log `queue empty (0 ready, X blocked, Y in-progress)` so the user knows _why_ nothing happened.

### 4. Show git operations as they happen

**Cinder:** Echoes the literal git output (`From https://github.com/stevekinney/cinder`, `Preparing worktree (new branch 'next/0a423b46')`, `HEAD is now at c3b83c1 …`) so the operator sees fetch + worktree creation in real time.

**Scrumlord:** `prepareTaskWorktree` does all of this silently and only logs one line at the end (`claimed task on branch …, worktree …`). Worktree creation on a fresh repo can take 5-10 seconds; that's a chunk of dead time where the user sees nothing.

**Action:** Have `prepareTaskWorktree` accept a `log` callback and emit `fetching origin/<base>`, `creating worktree at <path>`, `HEAD now at <sha>` lines as it works. Same callback shape as the pipeline logger.

### 5. PR identity verification (`pr.body.includes(taskId)`)

**Cinder:** Before treating any PR as "the" PR for a task, cinder filters candidates by `pr.body.includes(inputs.task.id)` AND `pr.createdAt >= task.createdAt`. This is the only thing that makes the recovery classifier safe to run on a long-lived repo where branches and PR titles can collide across tasks.

**Scrumlord:** `pullRequestForTask` and the recovery sweep match purely by `headRefName === task.branch`. If a branch gets reused (rare but happens — say a human force-pushed a different task onto the same branch), the pipeline will attach to the wrong PR and the recovery classifier may produce a `complete-safe` for the wrong task.

**Action:** Add a `prBodyMustReferenceTaskId` filter (default on) in `pullRequestForTask` and `gatherRecoveryInputs`. Inject the task id into the body of every PR the pipeline opens. Test the wrong-task-id case explicitly.

### 6. Inject task id into PR body so verification works end-to-end

**Cinder:** `committee-review` (or its predecessor) writes the task id into the PR body so identity verification can pick it up later. Cinder bakes this assumption into its classifier.

**Scrumlord:** The `next-task` skill is what opens the PR for us; we have no enforcement that the skill includes the task id in the body. If the skill stops doing this, identity verification (improvement 5) breaks silently.

**Action:** Either (a) have the pipeline open the PR itself with `gh pr create --body "<task-id> …"` after the agent commits, and tell the agent _not_ to open one, or (b) add a post-spawn check that fetches the open PR for the branch, reads its body, and appends a `pipeline-task: <task-id>` line if missing. (a) is simpler but conflicts with our "agent owns the PR" contract.

### 7. Wait for expected review bots explicitly

**Cinder:** Has a configured list of `expectedBots` (default `['copilot-pull-request-reviewer']`). After `address-pr` runs, it polls until those bots have posted at least one review _and_ checks are green _and_ threads are resolved. Logs the pending bot names on every poll iteration: `Awaiting review bots (2/5): copilot-pull-request-reviewer`.

**Scrumlord:** Treats `readyToMerge` as the only signal. The reality is that on a repo with a copilot reviewer, the PR can be momentarily ready (no checks running, no unresolved threads) before copilot files its first review, and the pipeline will merge too early.

**Action:** Add `SCRUMLORD_PIPELINE_EXPECTED_BOTS` (comma-separated, default empty). When set, extend the readiness check to require each named bot has posted at least one review on the current head sha. Surface pending bots in the polling log line.

### 8. Use stdin for the agent prompt, not a positional argument

**Cinder:** `Bun.spawn(['claude', '-p', '--dangerously-skip-permissions'], { stdin: 'pipe' })` then writes the prompt body to stdin. Two reasons: prompts can exceed the platform argv limit (~256KB on macOS, smaller on some Linuxes), and shell quoting bugs are impossible if it never touches argv.

**Scrumlord:** Passes the prompt body as a positional CLI argument:

```
claude -p --dangerously-skip-permissions --worktree <branch> --append-system-prompt <prompt> <body>
```

The system prompt and the body are both in argv. For long plans + descriptions this risks `E2BIG` on Linux and is harder to debug because the prompt shows up in `ps`.

**Action:** Switch to stdin for the prompt body (and the system prompt if claude supports stdin for it — otherwise keep `--append-system-prompt` for the small system prompt and put the long body on stdin).

### 9. `--concurrency` and `--serialize`

**Cinder:** Supports `--concurrency <n>` (parallel workers via tmux) and `--serialize` (keep claiming until `tasks next` empty). The default is "run one task and stop." Concurrency was explicitly cut from scrumlord v1 to keep the global lockfile design simple, but `--serialize` is _exactly_ our default drain behavior.

**Scrumlord:** Always drains. Has no "run one task and stop" mode, which is what a user would want when they're trying the pipeline for the first time and want to see one task ship before letting it loose on the queue.

**Action:** Add `--once` (single-task mode, exit after first attempt) as the friendly entry point. Document `--max 1` is equivalent. `--concurrency` stays out of scope per the plan.

### 10. Log PR readiness as a structured one-liner

**Cinder:** `formatSnapshot` produces `5 pass / 2 pending / 0 fail; 1 unresolved; awaiting copilot-pull-request-reviewer`. Every count appears in every line; you can grep the log for a task and see the entire CI/review trajectory.

**Scrumlord:** Currently emits `CI ✓ all green, 0 unresolved review comments` only when all green and otherwise `CI 1✗ 3…`. Less consistent, harder to grep.

**Action:** Always emit the full quad: `pass=N pending=N fail=N unresolved=N bots-pending=…`. Bot list omitted when empty.

### 11. Capture agent stdout for `STUCK:` detection and post-mortem

**Cinder:** `runStreaming` tees the agent stdout to stderr AND captures it into a `captured` string. Then `if (/STUCK:/i.test(result.captured))` catches stuck signals on either channel. Logs the captured output to `tmp/last-claude-output.log` on failure for triage.

**Scrumlord:** Only inspects stderr for `STUCK:` (via regex inside `defaultSpawnAgent`). If the agent writes the stuck signal to stdout (which happens — `claude -p` prints to stdout by default), we miss it.

**Action:** Apply the `STUCK:` regex to both streams in the live `defaultSpawnAgent`. Optionally persist `tmp/pipeline-runs/<run-id>/<task-id>.log` containing the merged transcript for post-mortem.

### 12. Per-attempt sleep logging with attempt counters

**Cinder:** Every sleep prints `Checks pending (3/120) — sleeping 30s: 1 pass / 2 pending / 0 fail; ...`. The operator can see exactly which attempt is firing and a snapshot of _why_.

**Scrumlord:** Logs `no actionable signal; sleeping 30s before next poll` (no counter, no snapshot recap inline).

**Action:** Include `(attempt N/MAX)` and the snapshot in the sleep log line so any single line is a full status summary.

### 13. Stale-lock detection lets you `kill -9` and recover cleanly

**Cinder:** Per-task lock directories (`tmp/locks/<task-id>/`) with PID + timestamp, and `reapStaleLock` removes them when the PID is dead. Plus the recovery sweep classifies `liveLockHeld → manual` so even partial-state crashes are detected.

**Scrumlord:** Has a single global pipeline lockfile with stale-PID and stale-age reaping. But because we explicitly chose serial v1, we don't have per-task locks. That's fine — but the _recovery sweep_ doesn't know how to tell "I crashed mid-task" from "another pipeline is running" because there is no surviving lock to inspect.

**Action:** When the pipeline acquires the global lockfile, also write a per-task heartbeat marker (progress entry like `pipeline:heartbeat=<run>:<ts>`) every ~30s while a task is in-progress. Recovery can use the absence-of-recent-heartbeat as evidence that the prior pipeline died, not that it's still running.

### 14. Surface the worktree path so the user can `cd` in mid-run

**Cinder:** `[OK] Worktree at /Users/stevekinney/Developer/worktrees/next-solo-…` — full absolute path, copyable. If you want to peek at what the agent is doing, you `cd` there and look around.

**Scrumlord:** Logs `worktree <path>` but truncated via theme.muted and embedded mid-line. Functional but harder to spot.

**Action:** Surface the worktree path on its own line, undecorated, with a leading `cd` hint: `tip: cd <path> to inspect this task's worktree`.

### 15. Output `gh pr view --url` after the PR is found

**Cinder:** Prints the PR URL prominently when the PR is first detected.

**Scrumlord:** Has the URL in `theme.muted` form on the "PR #N found" line. Same data, less prominent.

**Action:** Echo the URL on its own line in the default theme color so it's clickable in iTerm/Terminal/VSCode.

### 16. Stub-mode dry-run that actually exercises the pipeline

**Cinder:** No equivalent — its dry-run is "show what would happen." Same as ours.

**Scrumlord:** Our `--dry-run` is also preview-only. But there's a related need: when developing the pipeline, you want to step through it with a fake `claude` that just commits a no-op and exits 0, against a fake `gh` that returns canned data. We wrote this design into the plan but never shipped the script.

**Action:** Ship `scripts/smoke-pipeline.ts` from the plan. Make it the default thing to run when verifying changes to `pipeline.ts`.

### 17. Implementation phase is ALSO silent in cinder — this is a `claude -p` quirk, not a pipeline bug

**Watched behavior:** After cinder logs `[PHASE] Implementing task ... in worktree` it sat with zero output for 5+ minutes. The agent is running and presumably making tool calls, but `claude -p` over a pipe (no TTY) does not stream its TUI output the way it does interactively. Both pipelines inherit this silence.

**Implications:**

- Our pipeline isn't uniquely bad at this — cinder has the same dead zone.
- Operators _will_ mistake this for a hang.
- The fix isn't more logging in the pipeline; it's making the agent's progress visible.

**Action:**

- Emit a heartbeat from the parent every ~30s during a child agent run: `agent still running (Xm elapsed, last activity Ys ago, idle cap Z)`. This is the single highest-value addition for the "looks like hanging" complaint.
- Investigate whether `claude -p --output-format stream-json` produces line-delimited progress events we could parse and re-emit as human-readable phase lines. (cinder doesn't do this; it'd be a scrumlord-only edge.)
- For Codex, `codex exec` similarly goes quiet under non-TTY. Same heartbeat strategy applies.

### 18. The plan-mode draft as a separate pipeline phase (not just an agent responsibility)

**Cinder:** Plan drafting is its own phase: a separate `claude -p` invocation that ONLY drafts the plan, invokes `plan-review`, writes the plan path back to the task, and exits. Then the implementation phase is a _second_ `claude -p` call that gets the plan as context.

**Scrumlord:** All four phases (plan, implement, committee-review, address-pr-to-merge) happen inside a single `claude -p` invocation via the `next-task` skill. That's nice in theory but it means a planning failure looks like an implementation failure looks like a review failure — all the same exit code, same opaque "agent_failed."

**Action:** Split scrumlord's pipeline into discrete phase invocations, mirroring cinder. Pros: each phase has its own log line, its own timeout cap, its own failure mode, and the operator can resume at the boundary. Cons: more orchestration in the parent. Worth it.

### 20. Commit count check before claiming PR

**Cinder:** After the implementation agent exits, cinder runs `countCommitsAhead(worktree, baseBranch)` and logs `5 commit(s) on next/0a423b46`. If the count is zero, that's an immediate red flag — agent finished without committing anything, treat as stuck.

**Scrumlord:** No commit-count check. If the agent finishes cleanly but never committed (a real failure mode — claude can think it's done and exit without `git commit`), we'll happily poll for a PR that will never exist and then fail with `pr_never_opened` after a 30s wait. Wasted time on a detectable error.

**Action:** After the implementation agent exits with code 0, run `git rev-list --count <base>..HEAD` in the worktree. If 0, fail fast with `no_commits_after_agent` and skip PR polling entirely.

### 21. Verify the PR exists immediately, not lazily during polling

**Cinder:** First thing post-implementation: `findOpenPr(branch)` and logs `Found existing PR #70: <url>`. Failing this check means the next-phase `committee-review` skill didn't open one — handled as a recoverable state (cinder can `gh pr create` itself in some flows).

**Scrumlord:** Enters the polling loop and does the PR lookup inside it, so the first PR-related log appears on round 1 of polling rather than as a discrete "PR exists" step.

**Action:** Add a discrete `verifyPullRequestExists` step between agent exit and polling. Log the URL prominently. Defines a single failure mode (`pr_never_opened`) instead of conflating it with polling.

### 22. Set status to `in-review` explicitly, not via sync-git-status inference

**Cinder:** After confirming the PR, explicitly `tasks set-status in-review`. Visible state transition.

**Scrumlord:** Relies on `tasks sync-git-status` inferring `in-review` from PR state. This works but isn't visible in the pipeline log — the operator can't tell when the task transitioned.

**Action:** Have the pipeline explicitly move the task to `in-review` once the PR is verified, and log it: `[step] task moved to in-review`. The `sync-git-status` call remains as defense-in-depth.

### 23. The agent's final status block on stdout is structured

**Watched behavior:** When claude finishes (in this case, after `address-pr` consensus), it dumps a structured summary to stdout:

```
All exit conditions are met:
- `unresolved_count: 0` …
- `checks_all_terminal: true` …
**Summary:** …
<promise>PR feedback addressed and CI passing</promise>
```

This is rich data — task-level evidence that the agent considers itself done, which conditions it checked, etc.

**Implications:** We could parse the `<promise>` tag or the bullet list as evidence-of-completion. We don't have to trust it, but having it in the pipeline log and the task progress is gold for post-mortem.

**Action:** Capture the agent's final ~50 lines of stdout. Persist them to `tmp/pipeline-runs/<run-id>/<task-id>.tail` and surface the `<promise>` line (if present) in the pipeline log: `[info] agent reports: PR feedback addressed and CI passing`.

### 25. "Not fully clean but no actionable feedback" — soft-accept escape hatch

**Watched behavior:** Cinder waited 5 minutes for copilot-pull-request-reviewer, the bot never reviewed, but checks were green and threads resolved. Cinder logged:

```
[WARN] Bots never reviewed within budget: copilot-pull-request-reviewer — proceeding anyway
[WARN] PR #70 not fully clean but has no actionable feedback — accepting
```

…and merged. The decision: if the only thing preventing merge is a bot that never showed up, but everything _actionable_ is green, ship it.

**Scrumlord:** Our `readyToMerge` is binary. If we add expected-bot tracking (improvement 7), we need this same fallback — otherwise a missing bot blocks merge forever.

**Action:** When `bots-pending.length > 0` but `checks.failing == 0`, `checks.pending == 0`, and `unresolvedThreads == 0`, after the bot-wait budget is exhausted, log `WARN bots never reviewed, no actionable feedback — accepting` and proceed to merge. This is the "soft acceptance" path. Configurable via `SCRUMLORD_PIPELINE_REQUIRE_BOTS=strict` for repos that genuinely require bot signoff.

### 26. Remove the worktree BEFORE merging

**Watched behavior:**

```
[17:33:08] [PHASE] Removing worktree before merge
[17:33:11] [PHASE] Merging PR #70
```

Cinder removes the per-task worktree _before_ invoking `gh pr merge`. Two reasons: (a) `gh pr merge --delete-branch` will fail if a worktree still has that branch checked out, and (b) cleanup is owned by the pipeline, not by GitHub.

**Scrumlord:** No worktree-removal step. We rely on `gh pr merge --delete-branch` to handle it, but the worktree on disk stays around forever, accumulating garbage. Eventually `git worktree list` becomes unmanageable.

**Action:** Add an explicit `removeWorktreeBeforeMerge` step. Use `git worktree remove --force <path>` (Claude-managed worktrees are under `~/.claude/projects/...`, Codex under `~/.codex/worktrees/...`; both should be removable). After successful merge, also `git branch -D <branch>` on the main repo if the local ref still exists.

### 27. Per-task lifecycle is observable in 5 distinct phase lines

**Watched cinder summary for one task:**

```
[OK] 5 commit(s) on next/0a423b46
[OK] Found existing PR #70: https://github.com/stevekinney/cinder/pull/70
[PHASE] Setting 0a423b46 to in-review
[PHASE] PR readiness check 1/5 for PR #70
[PHASE] Removing worktree before merge
[PHASE] Merging PR #70
[PHASE] Marking 0a423b46 as completed
[OK] Task 0a423b46 shipped — PR #70
```

Eight discrete events. Each one is a checkpoint the operator can grep for. The terminal `Task <id> shipped — PR #<n>` line is one-line success.

**Scrumlord:** Our equivalent path emits the merge log, the success line, and the summary — but not commit count, not the explicit in-review transition, not the worktree-removal step. Less granular checkpoints.

**Action:** Adopt cinder's 8-line per-task structure as the contract for what every task ships should look like. Failures should emit the same skeleton but with `[ERROR]` substituted at the failing point so the operator can scroll up and find exactly where it stopped.

### 24. Bot-aware polling — first round shows the breakdown immediately

**Cinder polling output:**

```
[PHASE] PR readiness check 1/5 for PR #70
[INFO] 2 pass / 0 pending / 0 fail; 0 unresolved; awaiting copilot-pull-request-reviewer
[INFO] Awaiting review bots (1/5): copilot-pull-request-reviewer
```

Round number, full quad on a single line, then the bot-wait counter on a separate line.

**Scrumlord:** Round number not shown, snapshot format inconsistent (only fires the verbose line when checks aren't green), no bot tracking.

**Action:** Already covered in improvements 7 and 10; this is the observed reference format to match.

### 19. Recovery sweep is per-task, with surviving lock detection

**Cinder:** Each in-progress task has its own lock dir. Recovery checks for live PID inside each dir, classifies the task accordingly. A pipeline crash leaves stale dirs and the next recovery sweep reaps them and reclassifies.

**Scrumlord:** Recovery sweep has no per-task lock to inspect. It infers state from the latest `pipeline:phase=...` marker, `gh pr list`, and worktree dirty/unpushed state. This is correct but it cannot distinguish "current pipeline is still working on this task" from "a previous pipeline crashed mid-task" — both look like "in-progress with some phase marker."

**Action:** See improvement 13 (heartbeats). The classifier should treat a recent heartbeat (within ~2× the heartbeat interval) as evidence that another pipeline is live and produce `manual: live-pipeline-detected` instead of any rollback verdict.

---

## Status

Tracking table for the workstreams that address the items above. Each row is the contract a workstream PR must satisfy. Update as each lands.

| #                         | Workstream       | Status                                                                                                           | PR        | Smoke scenario                                     |
| ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------- |
| 16                        | W0 smoke harness | merged                                                                                                           | 5c17060   | `green`, `empty`, `stuck-stderr`                   |
| 1, 8, 8b, 11, 23          | B-1              | merged                                                                                                           | 762b79e   | `prompt-stdin`, `promise-tag`                      |
| 2, 10, 12, 14, 15, 17, 24 | A                | merged                                                                                                           | 3f8db29   | `green`, `empty`                                   |
| 5, 6a, 6b, 6c             | B-2              | in progress                                                                                                      | (this PR) | `wrong-task-pr`, `footer-missing`, `footer-repair` |
| 4                         | A (codex path)   | shipped, not asserted in smoke (claude provider does not run git ops itself; codex-mode scenario follows in B-1) | 3f8db29   | —                                                  |
| 7, 25                     | D                | pending                                                                                                          | —         | —                                                  |
| 9                         | F                | pending                                                                                                          | —         | —                                                  |
| 13, 19                    | B-3              | pending                                                                                                          | —         | —                                                  |
| 20, 21, 22, 26, 27        | C                | pending                                                                                                          | —         | —                                                  |
| 3, 18                     | E                | pending                                                                                                          | —         | —                                                  |
