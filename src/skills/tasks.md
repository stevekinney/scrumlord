# Tasks CLI

Use the `tasks` CLI when you need to inspect or update the local task graph for this project.

## Rules

- Run commands from anywhere inside the project; the CLI resolves the Git root first and only then opens `tmp/tasks.db`.
- All data commands return JSON. Parse the JSON instead of scraping human-readable text.
- Run `tasks init` when the project has not been set up yet. It creates and migrates `tmp/tasks.db`, writes local task skills, and installs managed Scrumlord Lefthook jobs when a Lefthook configuration exists.
- Prefer `tasks available` or `tasks next` before choosing new work.
- Store the Git branch on tasks with `--branch` when work is branch-bound.
- Do not store worktree paths. Scrumlord derives the worktree from Git when it needs one.
- Do not edit `tmp/tasks.db` directly. Use the CLI so migrations, timestamps, and graph checks stay consistent.

## Task Lifecycle

- When you begin work on a `ready` task, immediately move it to `in-progress` and record the branch:
  `tasks update $TASK_ID --status in-progress --branch "$(git branch --show-current)"`.
- When you open the pull request for that branch, move the task to `in-review`.
- When the pull request is merged into `origin/main`, move the task to `completed`.
- Before changing status manually, run `tasks sync-git-status` if GitHub might already know the current pull request state.
- If `tasks setup-git-hooks` has been run in a repository with Lefthook, `tasks sync-git-status --quiet` handles lifecycle transitions from Git and GitHub state.
- Before merging, run `tasks pr status`. Only treat the pull request as merge-ready when `readyToMerge` is `true`.

## GitHub Review Workflow

- Use `tasks pr --url` to find the current branch pull request.
- Use `tasks pr status` for the complete readiness report: unresolved review comment IDs and URLs, pending checks, failed checks, and `readyToMerge`.
- Use `tasks comments` to inspect unresolved review comments before deciding what to fix.
- Use `tasks ci` to inspect pull request check status.
- If `tasks pr`, `tasks pr status`, `tasks comments`, or `tasks ci` fails with `gh_not_found`, install the GitHub CLI or continue with non-GitHub task commands.
- If a command fails with `pull_request_not_found`, open a pull request or keep the task in `in-progress`.
- If a command fails with `project_root_not_found`, move into the Git repository or npm workspace before retrying. Do not create or edit a database by hand.

## Useful Commands

```bash
tasks init
tasks next
tasks available
tasks blocked
tasks create --title "Write tests" --description "Add regression coverage" --priority 3
tasks update $TASK_ID --status in-progress --branch "$(git branch --show-current)"
tasks add-blocker $TASK_ID $BLOCKER_TASK_ID
tasks add-tag $TASK_ID testing
tasks sync-git-status --quiet
tasks pr --url
tasks pr status
tasks comments
tasks ci
```
