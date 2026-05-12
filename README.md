# Scrumlord

Scrumlord is a Bun-first task graph for local projects. It stores lightweight tasks in `tmp/tasks.db` at the resolved project root, gives you a JSON CLI for automation, exposes the same behavior as an importable TypeScript library, and can run as a local MCP server.

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

The package exposes a `tasks` binary. Data commands print JSON when they have a value, and failures print JSON to stderr with a non-zero exit code. `tasks next` intentionally prints nothing with exit code 0 when no task is available.

```bash
tasks --help
tasks create --help
tasks init
tasks setup status
tasks setup --yes
tasks setup-subagents
tasks create --title "Write tests" --description "Add regression coverage" --priority 3
tasks current-task
tasks set-branch "$(git branch --show-current)"
tasks start --cli codex
tasks session
tasks add-progress --message "Wrote the failing regression test"
tasks progress
tasks resume
tasks overview
tasks available
tasks list
tasks next
tasks remaining
tasks blocked
tasks blocked-by
tasks add-blocker $BLOCKER_TASK_ID
tasks add-tag testing
```

### Initialization

- `tasks init`: Resolve the project root, create and migrate `tmp/tasks.db`, write Codex, Claude, and Cursor task skills, and add managed Scrumlord jobs to an existing Lefthook configuration when one is present.
- `tasks setup`: Run the full interactive setup flow. Without flags, it asks colorized numbered-choice questions and writes a JSON summary. With `--yes`, it uses project-local defaults and configures installed providers only.
- `tasks setup --codex` or `tasks setup --claude`: Run setup for one provider and then launch that CLI from the project root with setup context and task-management instructions.
- `tasks setup status`: Return read-only setup state as JSON, including `tasksExecutable`, `projectRoot`, `databaseExists`, provider CLI paths, subagent paths, skill paths, and hook configuration presence.
- `tasks setup-subagents [codex|claude|--all] [--local|--global]`: Install the `scrumlord-task-manager` subagent. With no provider argument, only installed providers are configured. Project-local scope is the default.
- `tasks setup-agent-hooks`: Write global Claude and Codex hook configuration plus a shared Bun wrapper under `~/.scrumlord/hooks/`. User-prompt hooks infer the current branch task and inject compact task context automatically. Hooks exit quietly when the project is not initialized for Scrumlord or the `tasks` executable is unavailable unless `SCRUMLORD_DEBUG` is truthy.

### Help And Color

- `tasks --help` or `tasks help`: Show the main CLI help.
- `tasks <command> --help`: Show help for a command.
- `tasks help <command>`: Show help for a command.
- `tasks add-progress --help`: Show help for recording progress entries.
- `tasks setup status --help`: Show help for the nested setup status command.
- `tasks pr status --help`: Show help for the nested pull request readiness command.

Help output uses Bun’s native `Bun.color()` ANSI formatting. JSON data and JSON errors remain plain, parseable JSON for automation.

### Query Commands

- `tasks available`: Ready tasks that are not blocked, deleted, or archived and have no future start date.
- `tasks list`: Active tasks that are not deleted or archived.
- `tasks list --all`: All tasks, including archived and soft-deleted tasks.
- `tasks blocked`: Active tasks with at least one incomplete blocker.
- `tasks completed`: Completed tasks that have not been soft-deleted.
- `tasks get [task-id]`: A single task by ID.
- `tasks current-task`: The single active task assigned to the current Git branch, or `null` when none exists. If multiple active tasks match, it fails with `current_task_ambiguous`.
- `tasks with-tag <tag>`: Tasks with one normalized tag.
- `tasks with-all-tags <tag...>`: Tasks that have every supplied tag.
- `tasks with-any-tag <tag...>`: Tasks that have at least one supplied tag.
- `tasks with-branch <branch>`: Tasks associated with one Git branch.
- `tasks blocked-by [task-id]`: Tasks blocking the supplied task.
- `tasks blocking [task-id]`: Tasks blocked by the supplied task.
- `tasks priority <priority>`: Tasks with priority `1`, `2`, or `3`.
- `tasks next`: The next available task, preferring tasks with a plan before unplanned tasks. Empty stdout with exit code 0 means there is no available task, which lets automation loops stop without parsing `null`.
- `tasks remaining`: The number of active unfinished tasks, including tasks with future start dates. Completed, in-progress, deleted, and archived tasks are not counted.
- `tasks repository`: The current GitHub repository name, such as `stevekinney/scrumlord`.
- `tasks repository --url`: The full GitHub repository URL.
- `tasks session [task-id]`: Provider, session, branch, derived worktree, plan path, session data path, and warnings for a task.
- `tasks progress [task-id]`: Chronological progress entries recorded for a task.

Task listing commands that return task arrays accept `--planned` to keep only tasks with a plan path and `--unplanned` to keep only tasks without one. The filters are mutually exclusive.

Commands whose first positional argument is `[task-id]` can omit it. Scrumlord then uses the single active task assigned to the current Git branch, the same lookup exposed by `tasks current-task`. If no active task is assigned, the command fails with `current_task_not_found`; if more than one active task matches, it fails with `current_task_ambiguous`.

### Mutation Commands

- `tasks create --title <title> [--description <markdown>] [--priority 1|2|3] [--status draft|ready|in-progress|in-review|completed] [--draft] [--start-date <date>] [--due-date <date>] [--branch <branch>] [--plan <path>] [--provider claude|codex] [--session <id>] [--tag <tag>] [--tags <tag,tag>] [--parent <task-id>] [--blocked-by <task-id>]`
- `tasks update [task-id] [--title <title>] [--description <markdown>] [--priority 1|2|3] [--status <status>] [--start-date <date>] [--due-date <date>] [--branch <branch>] [--plan <path>] [--provider claude|codex] [--session <id>] [--parent <task-id>]`
- `tasks set-status [task-id] <draft|ready|in-progress|in-review|completed>`: Transition a task through any supported lifecycle status.
- `tasks set-branch [task-id] <branch>` and `tasks clear-branch [task-id]`: Manage branch metadata. Setting a branch moves a `draft` or `ready` task to `in-progress`.
- `tasks set-plan [task-id] <path>` and `tasks clear-plan [task-id]`: Manage the task plan path.
- `tasks set-session [task-id] <claude|codex> <session-id>` and `tasks clear-session [task-id]`: Manage provider session metadata.
- `tasks add-progress [task-id] --message <markdown> [--provider claude|codex] [--session <id>]`: Append a progress entry and move `draft` or `ready` tasks to `in-progress`. When provider or session are omitted, Scrumlord uses the task session metadata if it exists.
- `tasks delete [task-id]`: Soft-delete a task.
- `tasks archive [task-id]`: Mark a task as archived.
- `tasks restore [task-id]`: Clear `deleted` and `archived`.
- `tasks add-tag [task-id] <tag>`
- `tasks remove-tag [task-id] <tag>`
- `tasks set-parent [task-id] <parent-task-id>`
- `tasks clear-parent [task-id]`
- `tasks add-blocker [task-id] <blocked-by-task-id>`
- `tasks remove-blocker [task-id] <blocked-by-task-id>`
- `tasks cleanup <days>`: Permanently remove completed or archived tasks whose last modified timestamp is older than the supplied day count.

All flags use kebab case. Tags are trimmed and lowercased before storage. `branch`, `plan`, `provider`, and `session` are optional. Plan paths inside the project are stored relative to the project root; paths outside the project are stored as absolute paths. Worktree paths are not stored; Scrumlord derives the worktree from `git worktree list --porcelain`.

### Agent Sessions

- `tasks start [task-id] --cli <claude|codex>`: Start a task in an agent CLI. If `--cli` is omitted, Scrumlord uses `SCRUMLORD_CLI`; if neither is present, it fails before launching anything.
- `tasks resume [task-id]`: Resume the recorded provider session from the derived worktree when available, falling back to the project root.
- `tasks session [task-id]`: Return the task session report as JSON.
- `tasks current-task`: Show the task for the current branch when you need to inspect the inferred ID directly.
- `tasks add-progress [task-id] --message <markdown>`: Record what changed, what was learned, or why work is blocked. Recording progress moves `draft` or `ready` tasks to `in-progress`. Agent start prompts ask agents to use this after planning, major implementation steps, blockers, and handoffs.
- `tasks setup-agent-hooks`: Install global Claude and Codex hook configuration plus a shared Bun wrapper under `~/.scrumlord/hooks/`. The wrapper uses the hook payload working directory when available, falls back to the current process directory, invokes `tasks agent-hook`, and forwards `UserPromptSubmit` hook output so the inferred current task is injected into the agent context.
- `tasks setup-subagents`: Install project-local task-manager subagents for installed providers.
- `tasks agent-hook <claude|codex>`: Internal hook entrypoint that reads hook JSON from stdin. It records session IDs when available, writes plan content on plan-exit hooks, updates branch metadata after relevant Git commands, injects current task context on `UserPromptSubmit`, and runs Git status synchronization after pull request or merge commands.

Claude starts with native plan mode via `--permission-mode plan`. Codex starts with a `/plan` prompt because the local Codex CLI does not expose an equivalent plan-mode flag. Claude sessions are preallocated with `--session-id`; Codex sessions are recorded later when hooks expose a session identifier.

### Git Status Automation

Scrumlord can keep branch-bound tasks synchronized with Git and GitHub state:

- `tasks sync-git-status`: Look at the current Git branch, derive its worktree, inspect the matching pull request with `gh`, and update tasks whose `branch` equals the current branch.
- `tasks sync-git-status --quiet`: Run the same synchronization without printing JSON, which is useful in hooks.
- `tasks setup-git-hooks`: If a Lefthook configuration is present, add jobs for `post-checkout`, `post-commit`, `post-merge`, and `pre-push` that run `tasks sync-git-status --quiet`, then run `bun run lefthook install`.

The synchronization rules are intentionally small: assigning a branch to a `draft` or `ready` task moves it to `in-progress`, an open pull request for a task branch moves the task to `in-review`, and a pull request merged into `main` as the `origin/main` integration branch marks it `completed`.

### Errors And Recovery

Expected failures return JSON on stderr with a stable error code:

- `project_root_not_found`: Run `tasks` from inside a Git repository or npm workspace.
- `invalid_workspace_package_json`: Fix the nearest `package.json` that Scrumlord tried to inspect.
- `gh_not_found`: Install the GitHub CLI before using `tasks pr`, `tasks pr status`, `tasks overview`, `tasks comments`, or `tasks ci`.
- `gh_not_authenticated`: Run `gh auth login` or fix the current GitHub CLI authentication.
- `github_repository_not_found`: Configure the repository remote so `gh repo view` can resolve it.
- `pull_request_not_found`: Open a pull request for the current branch or continue with non-GitHub task commands.
- `current_task_not_found`: Assign exactly one active task to the current Git branch or pass the task ID explicitly.
- `current_task_ambiguous`: The current Git branch has multiple active tasks. Use `tasks with-branch "$(git branch --show-current)"` and choose the correct task explicitly.
- `ci_status_invalid`: Update `gh` or inspect `gh pr checks --json bucket,completedAt,link,name,state,workflow`; Scrumlord expected a JSON array.
- `git_branch_not_found`: Leave detached HEAD or set task branch metadata manually with `tasks set-branch [task-id] <branch>`.
- `invalid_date`, `invalid_date_range`, `invalid_priority`, and `invalid_status`: Fix the supplied task field.
- `dependency_edge_required`: Add an explicit blocker edge before marking a task `ready`, or keep the task in `draft`.
- `database_directory_failed`, `database_open_failed`, and `migration_failed`: Check `tmp/tasks.db`, filesystem permissions, and whether another process is holding the database.
- `lefthook_install_failed`: Fix Lefthook installation output and rerun `tasks setup-git-hooks`.
- `scrumlord_cli_required`: Pass `--cli` to `tasks start` or set `SCRUMLORD_CLI`.
- `provider_cli_not_found`: Install the selected provider CLI or choose another provider.
- `setup_input_required`: Run `tasks setup` from an interactive terminal, or use `tasks setup --yes`, `tasks setup --codex`, or `tasks setup --claude`.
- `setup_provider_conflict` and `setup_scope_conflict`: Pick only one provider flag and one scope flag.
- `task_session_missing`: Set `provider` and `session`, or run `tasks start [task-id] --cli <provider>` first.
- `plan_unreadable`: Fix the plan file permissions or clear the task plan field.

### Pull Request Commands

These commands resolve the current branch’s open pull request with the GitHub CLI. If `gh` is not installed, the command fails with a JSON error.

- `tasks pr`: Print the pull request URL. This is the same as `tasks pr --url`.
- `tasks pr --open`: Print the URL and open it in the system browser.
- `tasks pr status`: Print a full readiness report for the current pull request, including unresolved review comment IDs and URLs, pending CI checks, failed CI checks, and `readyToMerge`.
- `tasks overview`: Print all open pull requests for the project with CI status, unresolved review comment counts, and tasks whose `branch` matches each pull request head branch. Matching active tasks move to `in-review`.
- `tasks comments`: Print unresolved pull request review comments.
- `tasks ci`: Print pull request check status from `gh pr checks`.

`tasks pr status` sets `readyToMerge` to `true` only when every review thread is resolved and every reported check is green. Pending, failed, cancelled, errored, or unknown check states keep `readyToMerge` false and appear in the JSON report with any available check URL.

`tasks overview` returns an array. Each item includes `pullRequest`, `associatedTasks`, `reviewComments.unresolvedCount`, `continuousIntegration.status`, `continuousIntegration.checks`, and `readyToMerge`. The CI status is `success`, `failed`, or `pending`.

Scrumlord stores GitHub REST ETags in `tmp/github-etag-cache.json` and revalidates cached REST responses with `If-None-Match`. A `304 Not Modified` response reuses the cached JSON body, reducing primary REST rate-limit usage while keeping pull request and check data fresh. Review-thread reads stay on GraphQL and are not ETag cached.

### Agent Skill Setup

Scrumlord can write local agent instructions for the CLI:

```bash
tasks setup-skills codex
tasks setup-skills claude
tasks setup-skills cursor
tasks setup-skills --all
```

The generated files teach agents to use the CLI instead of editing `tmp/tasks.db` directly. They also tell agents to normalize all source priority schemes onto Scrumlord’s `1`-`3` scale, build a candidate dependency graph before creating tasks from long documents, avoid large parallel `tasks create` batches, let task-id commands infer the current branch task when the ID is omitted, rely on `tasks setup-agent-hooks` to inject current task context on user prompts, record progress with `tasks add-progress`, and verify blockers with graph queries after creation.

### Agent Subagent Setup

Scrumlord can also write provider-specific task-manager subagents:

```bash
tasks setup-subagents
tasks setup-subagents codex
tasks setup-subagents claude
tasks setup-subagents --all
tasks setup-subagents codex --global
```

The generated subagents are named `scrumlord-task-manager`. They start by running `which tasks`; if the CLI is missing, they stop with a clear installation message. They use `tasks setup status` before changing setup, decompose long documents into a candidate graph before writing, normalize priorities to `1`-`3`, create tasks with `tasks create`, let task-id commands infer the current branch task when the ID is omitted, record progress with `tasks add-progress`, transition status with `tasks set-status`, wire dependencies with `tasks add-blocker`, inspect existing work with `tasks list`, `tasks get`, `tasks progress`, `tasks with-tag`, `tasks blocked-by`, and `tasks blocking`, and never edit `tmp/tasks.db` directly.

Claude subagents are written to `.claude/agents/scrumlord-task-manager.md` for local scope or `~/.claude/agents/scrumlord-task-manager.md` for global scope. Scrumlord also merges `Bash(tasks:*)` and `Bash(which tasks:*)` into the selected Claude settings file.

Codex subagents are written to `.codex/agents/scrumlord-task-manager.toml` for local scope or `~/.codex/agents/scrumlord-task-manager.toml` for global scope. They use `sandbox_mode = "workspace-write"` with explicit instructions to mutate only through the `tasks` CLI.

## MCP Server

The package also exposes a `tasks-mcp` binary for local MCP clients. It uses stdio, resolves the same project root as the CLI, and opens `tmp/tasks.db` for one tool call at a time.

```json
{
  "mcpServers": {
    "scrumlord": {
      "command": "tasks-mcp",
      "args": ["--cwd", "/absolute/path/to/project"]
    }
  }
}
```

If `--cwd` is omitted, `tasks-mcp` uses the process working directory. Startup failures are written to stderr. Protocol responses use structured MCP content and include JSON text content for clients that display tool output directly.

The server registers typed `scrumlord_` tools for the task graph:

- Query tools: `scrumlord_available_tasks`, `scrumlord_list_tasks`, `scrumlord_blocked_tasks`, `scrumlord_completed_tasks`, `scrumlord_get_task`, `scrumlord_next_task`, `scrumlord_remaining_tasks`, tag, branch, priority, dependency, session, and progress queries.
- Mutation tools: `scrumlord_create_task`, `scrumlord_update_task`, `scrumlord_delete_task`, `scrumlord_archive_task`, `scrumlord_restore_task`, tag, status, branch, parent, blocker, plan, session, progress, and cleanup mutations.

MCP tool errors return `isError: true` with structured content shaped as `{ "error": { "code": "...", "message": "..." } }`.

## Library API

```ts
import {
  createScrumlordMcpServer,
  createTaskStore,
  next,
  remaining,
  resolveProjectRoot,
  tasksOverview,
} from 'scrumlord';

const root = await resolveProjectRoot();
const store = await createTaskStore();

const task = store.create({
  title: 'Write task graph tests',
  description: 'Cover dependency and tag queries.',
  priority: 3,
  tags: ['testing'],
  plan: 'tmp/tasks/task-graph-tests/PLAN.md',
});

console.log(store.available());
console.log(next(store));
console.log(remaining(store));
console.log(store.taskSession(task.id));
console.log(store.addProgress(task.id, { message: 'Wrote the failing regression test.' }));
console.log(store.progress(task.id));
console.log(await tasksOverview(store));
store.close();

const mcpServer = createScrumlordMcpServer({ cwd: root });
console.log(mcpServer.isConnected());
```

### Exports

The package root intentionally exposes the same operations as the CLI. These are the supported runtime exports:

- Project setup and root resolution: `createTaskStore`, `initializeProject`, `setupProject`, `setupStatus`, `setupSubagents`, `setupSelectionFromFlags`, `setupSelectionFromInput`, `launchProviderInvocation`, and `resolveProjectRoot`.
- MCP server helpers: `createScrumlordMcpServer`, `runScrumlordMcpServer`, and `withTaskStore`.
- CLI help and display helpers: `helpTopics`, `renderHelp`, and `createTheme`.
- Agent provider helpers: `agentProviders`, `getAgentProvider`, `buildTaskStartInvocation`, `buildTaskResumeInvocation`, `buildSetupInvocation`, `defaultTaskPlanPath`, `absoluteTaskPlanPath`, `resolveTaskSession`, `startTask`, `resumeTask`, `setupAgentHooks`, and `runAgentHook`.
- Skill, Git hook, and Git status helpers: `skillTargets`, `setupSkills`, `setupGitHooks`, `syncGitStatus`, `currentGitBranch`, `worktreeForBranch`, and `runCommand`.
- GitHub and overview helpers: `repositoryName`, `repositoryUrl`, `currentPullRequest`, `pullRequestUrl`, `pullRequestStatus`, `tasksOverview`, `unresolvedReviewComments`, `continuousIntegrationStatus`, `openPullRequests`, `reviewCommentsForPullRequest`, and `checksForPullRequest`.
- Task query helpers: `availableTasks`, `blockedTasks`, `completedTasks`, `getTask`, `currentBranchTask`, `listTasks`, `tasksWithTag`, `tasksWithAllTags`, `tasksWithAnyTags`, `tasksWithBranch`, `tasksBlockedBy`, `tasksBlocking`, `tasksWithPriority`, `tasksWithSession`, `persistedTaskSession`, `taskProgress`, `next`, `nextTask`, `remaining`, and `remainingTasks`.
- Task mutation helpers: `createTask`, `updateTask`, `deleteTask`, `archiveTask`, `restoreTask`, `addTaskTag`, `removeTaskTag`, `setTaskStatus`, `setTaskBranch`, `clearTaskBranch`, `setTaskParent`, `clearTaskParent`, `addTaskBlocker`, `removeTaskBlocker`, `setTaskPlan`, `clearTaskPlan`, `setTaskSession`, `clearTaskSession`, `addTaskProgress`, and `cleanupTasks`.
- Error helper: `ScrumlordError`.

The package root also exports companion types for every public function signature:

- Agent types: `AgentCliProvider`, `AgentHookOptions`, `AgentHookResult`, `AgentInvocation`, `AgentProvider`, `AgentResumeInvocationContext`, `AgentSetupInvocationContext`, `AgentSessionPathOptions`, `AgentStartInvocationContext`, `ResolveTaskSessionOptions`, `TaskAgentCommandOptions`, and `TaskAgentCommandResult`.
- Command, color, setup, error, and Git status types: `ColorMode`, `CommandResult`, `CommandRunner`, `CurrentBranchTaskOptions`, `CreateTaskStoreOptions`, `InitializeProjectOptions`, `InitializeProjectResult`, `ScrumlordError`, `SetupAgentHooksOptions`, `SetupAgentHooksResult`, `SetupGitHooksOptions`, `SetupGitHooksResult`, `SetupProjectOptions`, `SetupProjectResult`, `SetupSelection`, `SetupStatus`, `SetupStatusProvider`, `SetupStatusSkill`, `SetupSubagentsOptions`, `SetupSubagentsResult`, `SkillTarget`, `SubagentScope`, `SyncGitStatusOptions`, `SyncGitStatusResult`, `SynchronizedPullRequestState`, `Theme`, `WhichExecutable`, `WrittenSkill`, `WrittenSubagent`, and `WrittenSubagentSkill`.
- MCP types: `ScrumlordMcpServerOptions`.
- GitHub types: `GitHubOptions`, `PullRequest`, `PullRequestCheck`, `PullRequestCheckConclusion`, `PullRequestCheckReport`, `PullRequestOverviewItem`, `PullRequestStatusReport`, and `ReviewComment`.
- Task and store types: `AddTaskProgressInput`, `CleanupTasksResult`, `CreateTaskInput`, `DateInput`, `PersistedTaskSession`, `Task`, `TaskIdentifier`, `TaskProgress`, `TaskPriority`, `TaskReference`, `TaskSession`, `TaskStatus`, `TaskStore`, and `UpdateTaskInput`.

### Task Store Methods

- `create(input)`: Create a task. IDs default to `crypto.randomUUID()`, status defaults to `ready`, priority defaults to `1`, and timestamps are UTC ISO strings.
- `update(id, input)`: Update task fields and refresh `lastModifiedAt`.
- `delete(id)`: Soft-delete a task.
- `archive(id)`: Mark a task archived.
- `restore(id)`: Clear `deleted` and `archived`.
- `getTask(id)`: Return one task or `null`.
- `list(options)`: Return active tasks by default, or all tasks when `includeInactive` is true.
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
- `next()`: Return the next available task, preferring planned tasks before unplanned tasks.
- `remaining()`: Count active unfinished tasks, including future-start tasks.
- `cleanup(days)`: Permanently remove old completed or archived tasks.
- `addTag(id, tag)` and `removeTag(id, tag)`: Manage tags.
- `setParent(id, parent)` and `clearParent(id)`: Manage parent task relationships.
- `addBlocker(id, blockedBy)` and `removeBlocker(id, blockedBy)`: Manage dependency edges.
- `setPlan(id, plan)`: Set or clear the task plan path.
- `setSession(id, provider, session)`: Set the provider and session ID for a task.
- `withSession(provider, session)`: Return active tasks matching provider session metadata.
- `taskSession(id)`: Return persisted session metadata for a task.
- `progress(id)`: Return chronological progress entries for a task.
- `addProgress(id, input)`: Append a progress entry, refresh the task `lastModifiedAt` timestamp, and move `draft` or `ready` tasks to `in-progress`. If provider or session are omitted, the task's stored provider and session are used.
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
  plan: string | null;
  provider: 'claude' | 'codex' | null;
  session: string | null;
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

Progress entries are returned separately so regular task listings stay compact:

```ts
type TaskProgress = {
  id: string;
  taskId: string;
  message: string;
  createdAt: string;
  provider: 'claude' | 'codex' | null;
  session: string | null;
};
```

## Database And Migrations

Scrumlord creates `tmp/tasks.db` only after root resolution succeeds. The database has normalized tables for tasks, tags, parent relationships, dependency edges, task progress, and applied migrations. Migrations run automatically when the task store opens.

Parent relationships and dependency edges reject self-references and cycles. Foreign keys cascade cleanup rows for tags, dependencies, and progress entries when a task is permanently removed.
