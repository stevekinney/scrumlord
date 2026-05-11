# Tasks CLI

Use the `tasks` CLI when you need to inspect or update the local task graph for this project.

## Rules

- Run commands from anywhere inside the project; the CLI resolves the Git root first and only then opens `tmp/tasks.db`.
- All data commands return JSON. Parse the JSON instead of scraping human-readable text.
- Prefer `tasks available` or `tasks next` before choosing new work.
- Store the Git branch on tasks with `--branch` when work is branch-bound. Do not store a worktree path; Scrumlord derives the worktree from Git.
- Do not edit `tmp/tasks.db` directly. Use the CLI so migrations, timestamps, and graph checks stay consistent.

## Status Workflow

- When you begin work on a `ready` task, immediately move it to `in-progress` and record the branch:
  `tasks update $TASK_ID --status in-progress --branch "$(git branch --show-current)"`.
- When you open the pull request for that branch, move the task to `in-review`.
- When the pull request is merged into `origin/main`, move the task to `completed`.
- If `tasks setup-git-hooks` has been run in a repository with Lefthook, `tasks sync-git-status --quiet` handles those transitions from Git and GitHub state.

## Useful Commands

```bash
tasks next
tasks available
tasks blocked
tasks create --title "Write tests" --description "Add regression coverage" --priority 3
tasks update $TASK_ID --status in-progress --branch "$(git branch --show-current)"
tasks add-blocker $TASK_ID $BLOCKER_TASK_ID
tasks add-tag $TASK_ID testing
tasks sync-git-status --quiet
tasks pr --url
tasks comments
tasks ci
```
