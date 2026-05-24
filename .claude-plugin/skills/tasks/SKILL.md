---
description: Inspect and update the local Scrumlord task graph.
---

# Tasks CLI

Use the `tasks` CLI when you need to inspect or update the local task graph for this project.

## Rules

- Run commands from anywhere inside the project; the CLI resolves the Git root first and only then opens `tmp/tasks.db`.
- Data commands run in three output modes: pretty when stdout is a TTY (for humans), JSON when stdout is not a TTY (the agent case), and JSON whenever `--json` is passed. Pass `--json` explicitly when you need machine-parseable output regardless of context, and parse the JSON instead of scraping human-readable text.
- If `tasks peek` prints nothing and exits 0, there is no available task; stop instead of treating that as an error.
- Use `tasks remaining` when you need a count of unfinished tasks, including tasks with future start dates.
- Run `tasks init` when the project has not been set up yet. It creates and migrates `tmp/tasks.db`, writes local task skills, and installs managed Scrumlord Lefthook jobs when a Lefthook configuration exists.
- Run `tasks setup status` before changing setup. It reports whether `tasks`, provider CLIs, skills, subagents, hooks, and `tmp/tasks.db` are present without creating the database.
- Use `tasks setup --yes` for the default full setup when the user wants Scrumlord initialized for installed providers. Use `tasks setup --codex` or `tasks setup --claude` only when the user wants that CLI launched after setup.
- Use `tasks setup --subagents` to install the `scrumlord-task-manager` subagent for installed providers. Use `tasks setup --subagents --agent codex`, `tasks setup --subagents --agent claude`, or `tasks setup --subagents --agent all` when a provider is explicit.
- Use `tasks setup --shell` to emit shell helpers (e.g. `tasks-teleport`, `tasks-start`) for the user's `.zshrc` or `.bashrc`. Pair with `tasks completions <bash|zsh>` when the user also wants shell completions.
- Use `tasks teleport <task-id>` to print the worktree path for a task. The canonical pattern is `cd "$(tasks teleport current)"` — never construct worktree paths yourself.
- Use `tasks --help` or `tasks <command> --help` when you need the current command syntax. Help output is colorized for humans; data output stays parseable JSON.
- If you need the task for the current branch and do not already have a task ID, run `tasks current` before falling back to `tasks peek`.
- Commands that accept a `<task-id>` require one. Pass a UUID, a unique UUID prefix, the literal `current` (the active task on the current Git branch), or the literal `next` (the next claimable task). Tokens are case-sensitive. Prefer `current` for branch-local work; pass an explicit UUID or unique prefix when operating on a specific other task.
- Prefer `tasks available` or `tasks peek` before choosing new work.
- Use `tasks list` before decomposing a long document or checklist so you can avoid duplicating existing tasks. Use `tasks list --all` only when archived or deleted tasks matter. Use `tasks search "<query>"` to fuzzy-search by title and description before creating a task that might already exist under a different phrasing.
- `tasks get` and `tasks list` return a computed `blocked` boolean and per-blocker status on each task. Read that field instead of cross-referencing `tasks blocked-by` manually when you just need to know whether a task is currently blocked.
- Scrumlord priorities are only `1`, `2`, and `3`, with `3` highest. Never pass `0`, `4`, `5`, `P0`, `P4`, or any source-specific rank through unchanged; normalize source priorities onto the 1-3 scale before running `tasks create`.
- Value flags accept both `--flag value` and `--flag=value`. Use the `=value` form when a value would otherwise be ambiguous: a description whose text begins with `--` (e.g. `--description=--keep-this-literal`) or an intentionally empty value (e.g. `--description=`). The space-separated form rejects a value that starts with `--` or is missing.
- Store the Git branch on tasks with `tasks update current --branch <branch>` when work is branch-bound. Setting a branch moves a `draft` or `ready` task to `in-progress`.
- Do not store worktree paths. Scrumlord derives the worktree from Git when it needs one.
- Use `tasks session current` before resuming or inspecting agent session state.
- Use `tasks progress` before resuming or handing off work so you can see recent progress for the current task. Use `tasks progress list current --full` when you need every entry.
- If a task has a `plan`, read that plan file before taking on the task.
- If you generate a plan, write it to the task plan file and update the task with `tasks update current --plan <path>`.
- Use `tasks plan <task-id>` to emit a ready-to-use planning prompt for a single task, or `tasks plan` with no argument to emit prompts for every unplanned task. This is the entry point the `plan-tasks` workflow drives — prefer it over hand-rolling a prompt.
- If you re-enter plan mode for a task, update the existing plan file or replace it with the new plan you generate.
- Record meaningful progress with `tasks progress add current --message "<note>"` after planning, major implementation steps, blockers, and handoffs. Recording progress moves `draft` or `ready` tasks to `in-progress`.
- Do not edit `tmp/tasks.db` directly. Use the CLI so migrations, timestamps, and graph checks stay consistent.

## Decomposing Documents Into Tasks

- Before creating tasks from a roadmap, specification, or checklist, first build a candidate graph: task title, description source, normalized priority, tags, and blockers.
- Do not create a flat list unless the items are genuinely independent. If one task unlocks or must precede another, create both tasks and then run `tasks blockers add <blocked-task-id> <blocker-task-id>`.
- Treat dependency language as graph data. Phrases such as "gated on", "blocked by", "depends on", "prerequisite", or "once ... exists" require an explicit blocker edge before the task can be marked `ready`. This rule is enforced on the transition into `ready` (via `tasks update <id> --status ready`), not at `tasks create` — creating a task with such phrasing in its description always succeeds, so add the blocker edge before marking it ready.
- Create prerequisite tasks before dependent tasks so you have stable task IDs for `tasks blockers add`.
- For large imports, do not fire many `tasks create` commands in parallel. Validate the priority scale and required flags first, then create tasks serially or in small batches so one malformed command cannot cancel the whole batch.
- After creating tasks, verify the graph with `tasks list`, `tasks blocked`, `tasks available`, `tasks blocked-by <task-id>`, and `tasks blocking <task-id>` as appropriate.
- If no dependency edges exist, say that explicitly in the summary so the user knows the graph was considered, not skipped.

## Task Lifecycle

- When you begin work on a `draft` or `ready` task, record the branch:
  `tasks update current --branch "$(git branch --show-current)"`.
- If an agent session loses its task ID, recover it with `tasks current`. If that returns `current_task_ambiguous`, inspect `tasks with-branch "$(git branch --show-current)"` and choose explicitly.
- After planning, substantial implementation steps, blocker discovery, and handoffs, append a progress note:
  `tasks progress add current --message "Wrote the failing regression test"`.
- When GitHub has an open pull request whose head branch matches the task branch, `tasks pr --sync` and `tasks overview` move the task to `in-review`.
- When the pull request is merged into `origin/main`, move the task to `completed` with `tasks update current --status completed`, or mark one or more tasks done in a batch with `tasks complete <task-id>...`. Already-completed tasks are left untouched and soft-deleted tasks are rejected.
- Prefer `tasks start current --cli codex` or `tasks start current --cli claude` when beginning branch-local agent-owned work. It materializes a per-task worktree under `~/.scrumlord/worktrees/` (with a `tmp/worktrees/` fallback) and launches the provider in that worktree, launches the provider with task context, starts in plan mode, and records provider/session metadata when the provider supports it. The payload includes a `phase` field (`start | resume-planning | resume-implementation`) derived from observable task state, and the system prompt names the workflow: plan → implement → `committee-review` (which opens the PR) → `address-pr` (which drives it to merge). Do not run `gh pr create` yourself.
- Use `tasks pipeline --cli <claude|codex>` to drain the ready queue end-to-end: it claims tasks atomically, materializes worktrees, delegates each per-task run to the agent CLI (Claude side uses the `next-task` skill; Codex side gets a self-contained four-phase prompt), polls each pull request to merge, then continues. The pipeline is the merge authority — agents must drive PRs to merge or exit with `STUCK: <reason>` on stderr. A single lockfile (`tmp/pipeline.lock`) protects against concurrent pipelines. `--recover` runs an annotate-only recovery sweep (pair with `--apply` to mutate). `--dry-run` previews without claiming. `--json` emits a structured summary on stdout.
- Re-run `tasks start current --cli <claude|codex>` on an in-progress task to reattach the recorded provider session — `start` detects the existing session and runs the provider's native resume instead of re-claiming.
- Before changing status manually, run `tasks pr --sync` if GitHub might already know the current pull request state.
- If `tasks setup --git-hooks` has been run in a repository with Lefthook, `tasks pr --sync --quiet` handles lifecycle transitions from Git and GitHub state.
- If `tasks setup --agent-hooks` has been run, global Claude and Codex hooks try to keep plan, session, branch, and pull request lifecycle state synchronized, and they inject the inferred current branch task into agent context on user prompts. Hooks exit quietly when the project is not initialized for Scrumlord or `tasks` is unavailable unless `SCRUMLORD_DEBUG` is truthy.
- Before merging, run `tasks pr`. Only treat the pull request as merge-ready when `readyToMerge` is `true`.
- Use `tasks cleanup` to prune the graph: `--aged` removes long-idle completed tasks, `--orphans-only` removes tasks whose worktree or branch is gone, `--aged-and-orphans` does both, and `--prompt` walks the user through interactive recovery. Combine with `--hard` for permanent deletion, `--recover-orphans` to revive orphans instead of deleting, and `--dry-run` to preview without writing.
- When waiting on CI or bot reviews between push cycles, use `tasks pr --poll` instead of calling `tasks pr` in a manual loop. It re-fetches up to `--max-polls` times (default 5) with `--poll-interval` seconds between each (default 20). It always exits 0; check `poll.pollsExhausted` and `readyToMerge` in the JSON output. `poll.botsPending`, `poll.mergeabilityPending`, and `poll.hasMergeConflict` mirror the `pr-status.ts` parity fields.

## GitHub Review Workflow

- Use `tasks pr --url` to find the current branch pull request.
- Use `tasks pr` for the complete readiness report: unresolved review comment IDs and URLs, pending checks, failed checks, and `readyToMerge`.
- Use `tasks overview` to inspect every open pull request for the project with CI status, unresolved review comment counts, merge-conflict state, and branch-associated tasks. Use `tasks overview --watch` for a terminal dashboard that refreshes every 30 seconds. In an interactive terminal the PR number is a clickable link to GitHub.
- Use `tasks complete --sync` to clear the merge queue in one pass: it reports which open pull requests are ready to merge (CI green, no unresolved comments, no conflicts) and the tasks they would complete. It is read-only and dry-run by default; add `--apply` to squash-merge each ready pull request and complete its tasks, and `--all` to also merge ready pull requests that have no associated task. The command exits non-zero if any merge or completion fails.
- Use `tasks pr --comments` to inspect unresolved review comments before deciding what to fix; add `--resolved` for resolved threads or `--all` for both.
- If `tasks pr` or `tasks overview` fails with `gh_not_found`, install the GitHub CLI or continue with non-GitHub task commands.
- If a command fails with `pull_request_not_found`, open a pull request or keep the task in `in-progress`.
- If a command fails with `project_root_not_found`, move into the Git repository or npm workspace before retrying. Do not create or edit a database by hand.

## Useful Commands

```bash
tasks --help
tasks create --help
tasks init
tasks peek
tasks current
tasks list
tasks remaining
tasks session current
tasks progress
tasks progress list current --full
tasks start current --cli codex
tasks available
tasks blocked
tasks status in-progress
tasks create --title "Write tests" --description "Add regression coverage" --priority 3
tasks update current --branch "$(git branch --show-current)"
tasks progress add current --message "Wrote the failing regression test"
tasks blockers add current $BLOCKER_TASK_ID
tasks tags add current testing
tasks pr --sync --quiet
tasks pr --url
tasks pr
tasks pr --poll
tasks pr --poll --max-polls 10 --poll-interval 15
tasks overview
tasks complete $TASK_ID
tasks complete $TASK_ID_A $TASK_ID_B
tasks complete --sync
tasks complete --sync --apply
tasks complete --sync --apply --all
tasks pr --comments
tasks setup status
tasks setup --yes
tasks setup --subagents
tasks setup --agent-hooks
tasks setup --shell
tasks search "<query>"
tasks teleport current
tasks plan
tasks plan current
tasks cleanup --prompt
tasks completions zsh
tasks list --json
```
