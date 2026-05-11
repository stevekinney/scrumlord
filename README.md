# Scrumlord

Scrumlord is a Bun-first task graph for local projects. It stores lightweight tasks in `tmp/tasks.db` at the resolved project root, gives you a JSON CLI for automation, and exposes the same behavior as an importable TypeScript library.

The critical rule is root resolution: Scrumlord resolves the project root before opening or creating a database. It first asks Git for the repository root. If the current directory is not inside Git, it walks upward until it finds a `package.json` with npm-style `workspaces`. If neither exists, it exits without touching the filesystem.

> [!NOTE]
> This package is intentionally Bun-only. It uses `bun:sqlite`, Bun Shell, and Bun-native file APIs.

## Installation

```bash
bun add scrumlord
```

During local development in this repository:

```bash
bun install
bun run build
bun run validate
```

## CLI

The package exposes a `tasks` binary. All data commands print JSON, and failures print JSON to stderr with a non-zero exit code.

```bash
tasks create --title "Write tests" --description "Add regression coverage" --priority 3
tasks update $TASK_ID --status in-progress --branch "$(git branch --show-current)"
tasks available
tasks next
tasks blocked
tasks blocked-by $TASK_ID
tasks add-blocker $TASK_ID $BLOCKER_TASK_ID
tasks add-tag $TASK_ID testing
```

### Query Commands

- `tasks available`: Ready tasks that are not blocked, deleted, or archived and have no future start date.
- `tasks blocked`: Active tasks with at least one incomplete blocker.
- `tasks completed`: Completed tasks that have not been soft-deleted.
- `tasks get <task-id>`: A single task by ID.
- `tasks with-tag <tag>`: Tasks with one normalized tag.
- `tasks with-all-tags <tag...>`: Tasks that have every supplied tag.
- `tasks with-any-tag <tag...>`: Tasks that have at least one supplied tag.
- `tasks with-branch <branch>`: Tasks associated with one Git branch.
- `tasks blocked-by <task-id>`: Tasks blocking the supplied task.
- `tasks blocking <task-id>`: Tasks blocked by the supplied task.
- `tasks priority <priority>`: Tasks with priority `1`, `2`, or `3`.
- `tasks next`: The highest-priority available task.

### Mutation Commands

- `tasks create --title <title> [--description <markdown>] [--priority 1|2|3] [--status draft|ready|in-progress|in-review|completed] [--draft] [--start-date <date>] [--due-date <date>] [--branch <branch>] [--tag <tag>] [--tags <tag,tag>] [--parent <task-id>] [--blocked-by <task-id>]`
- `tasks update <task-id> [--title <title>] [--description <markdown>] [--priority 1|2|3] [--status <status>] [--start-date <date>] [--due-date <date>] [--branch <branch>] [--parent <task-id>]`
- `tasks delete <task-id>`: Soft-delete a task.
- `tasks archive <task-id>`: Mark a task as archived.
- `tasks restore <task-id>`: Clear `deleted` and `archived`.
- `tasks add-tag <task-id> <tag>`
- `tasks remove-tag <task-id> <tag>`
- `tasks set-parent <task-id> <parent-task-id>`
- `tasks clear-parent <task-id>`
- `tasks add-blocker <task-id> <blocked-by-task-id>`
- `tasks remove-blocker <task-id> <blocked-by-task-id>`
- `tasks cleanup <days>`: Permanently remove completed or archived tasks whose last modified timestamp is older than the supplied day count.

All flags use kebab case. Tags are trimmed and lowercased before storage. `branch` is optional and stored as text. Worktree paths are not stored; `tasks sync-git-status` derives the current worktree from `git worktree list --porcelain`.

### Git Status Automation

Scrumlord can keep branch-bound tasks synchronized with Git and GitHub state:

- `tasks sync-git-status`: Look at the current Git branch, derive its worktree, inspect the matching pull request with `gh`, and update tasks whose `branch` equals the current branch.
- `tasks sync-git-status --quiet`: Run the same synchronization without printing JSON, which is useful in hooks.
- `tasks setup-git-hooks`: If a Lefthook configuration is present, add jobs for `post-checkout`, `post-commit`, `post-merge`, and `pre-push` that run `tasks sync-git-status --quiet`, then run `bun run lefthook install`.

The synchronization rules are intentionally small: a `ready` task on the current branch becomes `in-progress` when work begins, an open pull request moves it to `in-review`, and a pull request merged into `main` as the `origin/main` integration branch marks it `completed`.

### Pull Request Commands

These commands resolve the current branch’s open pull request with the GitHub CLI. If `gh` is not installed, the command fails with a JSON error.

- `tasks pr`: Print the pull request URL. This is the same as `tasks pr --url`.
- `tasks pr --open`: Print the URL and open it in the system browser.
- `tasks comments`: Print unresolved pull request review comments.
- `tasks ci`: Print pull request check status from `gh pr checks`.

### Agent Skill Setup

Scrumlord can write local agent instructions for the CLI:

```bash
tasks setup-skills codex
tasks setup-skills claude
tasks setup-skills cursor
tasks setup-skills --all
```

The generated files teach agents to use the CLI instead of editing `tmp/tasks.db` directly.

## Library API

```ts
import { createTaskStore, resolveProjectRoot } from 'scrumlord';

const root = await resolveProjectRoot();
const store = await createTaskStore();

const task = store.create({
  title: 'Write task graph tests',
  description: 'Cover dependency and tag queries.',
  priority: 3,
  tags: ['testing'],
});

console.log(store.available());
store.close();
```

### Exports

- `createTaskStore(options?)`: Resolve the project root, open `tmp/tasks.db`, run migrations, and return a task store.
- `resolveProjectRoot(cwd?)`: Resolve the Git or workspace root without creating the database.
- `setupSkills(projectRoot, target)`: Write agent skill files for `codex`, `claude`, `cursor`, or `--all`.
- `setupGitHooks(projectRoot)`: Add Scrumlord synchronization jobs to an existing Lefthook configuration.
- `syncGitStatus(store, options?)`: Synchronize branch-bound task statuses with the current Git branch and pull request state.
- `worktreeForBranch(projectRoot, branch, runner?)`: Derive a branch worktree from `git worktree list --porcelain`.
- `ScrumlordError`: Expected operational error with a stable `code`.
- Types: `Task`, `TaskIdentifier`, `TaskPriority`, `TaskReference`, `TaskStatus`, `TaskStore`, `CreateTaskInput`, `UpdateTaskInput`, and `DateInput`.

### Task Store Methods

- `create(input)`: Create a task. IDs default to `crypto.randomUUID()`, status defaults to `ready`, priority defaults to `1`, and timestamps are UTC ISO strings.
- `update(id, input)`: Update task fields and refresh `lastModifiedAt`.
- `delete(id)`: Soft-delete a task.
- `archive(id)`: Mark a task archived.
- `restore(id)`: Clear `deleted` and `archived`.
- `getTask(id)`: Return one task or `null`.
- `available()`: Return ready, unblocked, active tasks with no future start date.
- `blocked()`: Return active tasks with incomplete blockers.
- `completed()`: Return completed tasks that are not deleted.
- `withTag(tag)`: Return tasks with a normalized tag.
- `withAllTags(...tags)`: Return tasks containing every tag.
- `withAnyTag(...tags)`: Return tasks containing at least one tag.
- `withBranch(branch)`: Return tasks associated with a Git branch.
- `blockedBy(taskOrId)`: Return blockers of a task.
- `blocking(taskOrId)`: Return tasks that depend on a task.
- `withPriority(priority)`: Return tasks with a priority.
- `next()`: Return the first available task after priority sorting.
- `cleanup(days)`: Permanently remove old completed or archived tasks.
- `addTag(id, tag)` and `removeTag(id, tag)`: Manage tags.
- `setParent(id, parent)` and `clearParent(id)`: Manage parent task relationships.
- `addBlocker(id, blockedBy)` and `removeBlocker(id, blockedBy)`: Manage dependency edges.
- `close()`: Close the SQLite connection.

Returned `Task` objects include relationship IDs:

```ts
type Task = {
  id: string;
  title: string;
  status: 'draft' | 'ready' | 'in-progress' | 'in-review' | 'completed';
  description: string;
  priority: 1 | 2 | 3;
  createdAt: string;
  startDate: string | null;
  dueDate: string | null;
  branch: string | null;
  tags: string[];
  parent: string | null;
  subtasks: string[];
  blockedBy: string[];
  blocking: string[];
  lastModifiedAt: string;
  archived: boolean;
  deleted: boolean;
};
```

## Database And Migrations

Scrumlord creates `tmp/tasks.db` only after root resolution succeeds. The database has normalized tables for tasks, tags, parent relationships, dependency edges, and applied migrations. Migrations run automatically when the task store opens.

Parent relationships and dependency edges reject self-references and cycles. Foreign keys cascade cleanup rows for tags and dependencies when a task is permanently removed.
