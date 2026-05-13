# Tasks CLI

Use the `tasks` CLI when you need to inspect or update the local task graph for this project.

## Rules

- Run commands from anywhere inside the project; the CLI resolves the Git root first and only then opens `tmp/tasks.db`.
- Data commands return JSON when they have output. Parse the JSON instead of scraping human-readable text.
- If `tasks next` prints nothing and exits 0, there is no available task; stop instead of treating that as an error.
- Use `tasks remaining` when you need a count of unfinished tasks, including tasks with future start dates.
- Run `tasks init` when the project has not been set up yet. It creates and migrates `tmp/tasks.db`, writes local task skills, and installs managed Scrumlord Lefthook jobs when a Lefthook configuration exists.
- Run `tasks setup status` before changing setup. It reports whether `tasks`, provider CLIs, skills, subagents, hooks, and `tmp/tasks.db` are present without creating the database.
- Use `tasks setup --yes` for the default full setup when the user wants Scrumlord initialized for installed providers. Use `tasks setup --codex` or `tasks setup --claude` only when the user wants that CLI launched after setup.
- Use `tasks setup-subagents` to install the `scrumlord-task-manager` subagent for installed providers. Use `tasks setup-subagents codex`, `tasks setup-subagents claude`, or `tasks setup-subagents --all` when a provider is explicit.
- Use `tasks --help` or `tasks <command> --help` when you need the current command syntax. Help output is colorized for humans; data output stays parseable JSON.
- If you need the task for the current branch and do not already have a task ID, run `tasks current-task` before falling back to `tasks next`.
- Commands whose first positional argument is a task ID can omit it when exactly one active task is assigned to the current Git branch. Prefer omitted IDs for branch-local work once the branch is assigned; pass an explicit ID when operating on another task or when `current_task_ambiguous` is possible.
- Prefer `tasks available` or `tasks next` before choosing new work.
- Use `tasks list` before decomposing a long document or checklist so you can avoid duplicating existing tasks. Use `tasks list --all` only when archived or deleted tasks matter.
- Scrumlord priorities are only `1`, `2`, and `3`, with `3` highest. Never pass `0`, `4`, `5`, `P0`, `P4`, or any source-specific rank through unchanged; normalize source priorities onto the 1-3 scale before running `tasks create`.
- Store the Git branch on tasks with `tasks set-branch` when work is branch-bound. Setting a branch moves a `draft` or `ready` task to `in-progress`.
- Do not store worktree paths. Scrumlord derives the worktree from Git when it needs one.
- Use `tasks session [task-id]` before resuming or inspecting agent session state.
- Use `tasks progress [task-id]` before resuming or handing off work so you can see what previous agents recorded.
- If a task has a `plan`, read that plan file before taking on the task.
- If you generate a plan, write it to the task plan file and update the task with `tasks set-plan [task-id] <path>`.
- If you re-enter plan mode for a task, update the existing plan file or replace it with the new plan you generate.
- Record meaningful progress with `tasks add-progress [task-id] --message "<note>"` after planning, major implementation steps, blockers, and handoffs. Recording progress moves `draft` or `ready` tasks to `in-progress`.
- Do not edit `tmp/tasks.db` directly. Use the CLI so migrations, timestamps, and graph checks stay consistent.

## Decomposing Documents Into Tasks

- Before creating tasks from a roadmap, specification, or checklist, first build a candidate graph: task title, description source, normalized priority, tags, parent task, and blockers.
- Do not create a flat list unless the items are genuinely independent. If one task unlocks or must precede another, create both tasks and then run `tasks add-blocker <blocked-task-id> <blocker-task-id>`.
- Treat dependency language as graph data. Phrases such as "gated on", "blocked by", "depends on", "prerequisite", or "once ... exists" require an explicit blocker edge before the task can be marked `ready`.
- Create parent or prerequisite tasks before dependent tasks so you have stable task IDs for `tasks add-blocker` and `tasks set-parent`.
- For large imports, do not fire many `tasks create` commands in parallel. Validate the priority scale and required flags first, then create tasks serially or in small batches so one malformed command cannot cancel the whole batch.
- After creating tasks, verify the graph with `tasks list`, `tasks blocked`, `tasks available`, `tasks blocked-by [task-id]`, and `tasks blocking [task-id]` as appropriate.
- If no dependency edges exist, say that explicitly in the summary so the user knows the graph was considered, not skipped.

## Task Lifecycle

- When you begin work on a `draft` or `ready` task, record the branch:
  `tasks set-branch [task-id] "$(git branch --show-current)"`.
- If an agent session loses its task ID, recover it with `tasks current-task`. If that returns `current_task_ambiguous`, inspect `tasks with-branch "$(git branch --show-current)"` and choose explicitly.
- After planning, substantial implementation steps, blocker discovery, and handoffs, append a progress note:
  `tasks add-progress --message "Wrote the failing regression test"`.
- When GitHub has an open pull request whose head branch matches the task branch, `tasks sync-git-status` and `tasks overview` move the task to `in-review`.
- When the pull request is merged into `origin/main`, move the task to `completed` with `tasks set-status completed`.
- Prefer `tasks start --cli codex` or `tasks start --cli claude` when beginning branch-local agent-owned work. It creates the worktree and branch (Claude: via `claude --worktree`; Codex: under `~/.codex/worktrees/` with a `tmp/worktrees/` fallback), launches the provider with task context, starts in plan mode, and records provider/session metadata when the provider supports it. The payload includes a `phase` field (`start | resume-planning | resume-implementation`) derived from observable task state, and the system prompt names the workflow: plan → implement → `committee-review` (which opens the PR) → `address-pr` (which drives it to merge). Do not run `gh pr create` yourself.
- Use `tasks pipeline --cli <claude|codex>` to drain the ready queue end-to-end: it claims tasks atomically, materializes worktrees, delegates each per-task run to the agent CLI (Claude side uses the `next-task` skill; Codex side gets a self-contained four-phase prompt), polls each pull request to merge, then continues. The pipeline is the merge authority — agents must drive PRs to merge or exit with `STUCK: <reason>` on stderr. A single lockfile (`tmp/pipeline.lock`) protects against concurrent pipelines. `--recover` runs an annotate-only recovery sweep (pair with `--apply` to mutate). `--dry-run` previews without claiming. `--json` emits a structured summary on stdout.
- Use `tasks resume` to resume the current branch task's recorded Claude or Codex session from the derived worktree.
- Before changing status manually, run `tasks sync-git-status` if GitHub might already know the current pull request state.
- If `tasks setup-git-hooks` has been run in a repository with Lefthook, `tasks sync-git-status --quiet` handles lifecycle transitions from Git and GitHub state.
- If `tasks setup-agent-hooks` has been run, global Claude and Codex hooks try to keep plan, session, branch, and pull request lifecycle state synchronized, and they inject the inferred current branch task into agent context on user prompts. Hooks exit quietly when the project is not initialized for Scrumlord or `tasks` is unavailable unless `SCRUMLORD_DEBUG` is truthy.
- Before merging, run `tasks pr status`. Only treat the pull request as merge-ready when `readyToMerge` is `true`.

## GitHub Review Workflow

- Use `tasks pr --url` to find the current branch pull request.
- Use `tasks pr status` for the complete readiness report: unresolved review comment IDs and URLs, pending checks, failed checks, and `readyToMerge`.
- Use `tasks overview` to inspect every open pull request for the project with CI status, unresolved review comment counts, and branch-associated tasks.
- Use `tasks comments` to inspect unresolved review comments before deciding what to fix.
- Use `tasks ci` to inspect pull request check status.
- If `tasks pr`, `tasks pr status`, `tasks overview`, `tasks comments`, or `tasks ci` fails with `gh_not_found`, install the GitHub CLI or continue with non-GitHub task commands.
- If a command fails with `pull_request_not_found`, open a pull request or keep the task in `in-progress`.
- If a command fails with `project_root_not_found`, move into the Git repository or npm workspace before retrying. Do not create or edit a database by hand.

## Useful Commands

```bash
tasks --help
tasks create --help
tasks init
tasks next
tasks current-task
tasks list
tasks remaining
tasks session
tasks progress
tasks start --cli codex
tasks resume
tasks available
tasks blocked
tasks create --title "Write tests" --description "Add regression coverage" --priority 3
tasks set-branch "$(git branch --show-current)"
tasks add-progress --message "Wrote the failing regression test"
tasks add-blocker $BLOCKER_TASK_ID
tasks add-tag testing
tasks sync-git-status --quiet
tasks pr --url
tasks pr status
tasks overview
tasks comments
tasks ci
tasks setup status
tasks setup --yes
tasks setup-subagents
tasks setup-agent-hooks
```
