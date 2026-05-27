/* eslint-disable max-lines */
import { createTheme, type ColorMode, type Theme } from './color.js';

type HelpOption = {
  name: string;
  value?: string;
  description: string;
};

type HelpTopic = {
  path: string[];
  summary: string;
  usage: string;
  description: string;
  arguments?: string[];
  options?: HelpOption[];
  examples?: string[];
};

const globalOptions: HelpOption[] = [
  { name: '--help', description: 'Show help for the CLI or a specific command.' },
];

const taskPlanFilterOptions: HelpOption[] = [
  { name: '--planned', description: 'Only include tasks with a plan path.' },
  { name: '--unplanned', description: 'Only include tasks without a plan path.' },
];

const taskListingOptions: HelpOption[] = [
  ...taskPlanFilterOptions,
  { name: '--count', description: 'Print only the number of matching tasks.' },
];

const taskListOptions: HelpOption[] = [
  { name: '--all', description: 'Include soft-deleted tasks.' },
  { name: '--completed', description: 'Only include completed tasks.' },
  { name: '--incomplete', description: 'Only include tasks that are not completed.' },
  ...taskListingOptions,
];

const taskFieldOptions: HelpOption[] = [
  { name: '--title', value: '<title>', description: 'Short task title.' },
  { name: '--description', value: '<markdown>', description: 'Markdown task description.' },
  { name: '--priority', value: '<1|2|3>', description: 'Task priority. Defaults to 1.' },
  {
    name: '--status',
    value: '<status>',
    description: 'Task status: draft, ready, in-progress, in-review, or completed.',
  },
  { name: '--start-date', value: '<date>', description: 'Optional scheduled start date.' },
  { name: '--due-date', value: '<date>', description: 'Optional due date.' },
  { name: '--branch', value: '<branch>', description: 'Git branch associated with the task.' },
  { name: '--plan', value: '<path>', description: 'Filesystem path to the task plan.' },
  {
    name: '--provider',
    value: '<claude|codex>',
    description: 'Agent CLI provider associated with the task session.',
  },
  { name: '--session', value: '<id>', description: 'Provider-specific session identifier.' },
  { name: '--parent', value: '<task-id>', description: 'Parent task ID.' },
];

const requiredTaskIdArgument =
  '<task-id>: Task ID. Accepts a UUID, a unique UUID prefix, "current" (the active task on the current Git branch), or "next" (the next claimable task).';

const topics: HelpTopic[] = [
  {
    path: ['init'],
    summary: 'Initialize Scrumlord for the current project.',
    usage: 'tasks init',
    description:
      'Resolves the project root, creates and migrates tmp/tasks.db, writes local agent skills, and sets up managed Lefthook jobs when a Lefthook configuration exists.',
    examples: ['tasks init'],
  },
  {
    path: ['available'],
    summary: 'List ready, unblocked tasks.',
    usage: 'tasks available [--planned|--unplanned] [--count]',
    description:
      'Returns ready tasks that are not deleted, not blocked, and have no future start date.',
    options: taskListingOptions,
    examples: ['tasks available'],
  },
  {
    path: ['list'],
    summary: 'List tasks for graph reconciliation.',
    usage: 'tasks list [--all] [--completed|--incomplete] [--planned|--unplanned] [--count]',
    description:
      'Returns active tasks by default. Use --all to include soft-deleted tasks when reconciling long documents against the full graph.',
    options: taskListOptions,
    examples: ['tasks list', 'tasks list --all', 'tasks list --completed'],
  },
  {
    path: ['blocked'],
    summary: 'List currently blocked tasks.',
    usage: 'tasks blocked [--planned|--unplanned] [--count]',
    description: 'Returns active tasks with at least one incomplete blocker.',
    options: taskListingOptions,
    examples: ['tasks blocked'],
  },
  {
    path: ['completed'],
    summary: 'List completed tasks.',
    usage: 'tasks completed [--planned|--unplanned] [--count]',
    description: 'Returns completed tasks that have not been soft-deleted.',
    options: taskListingOptions,
    examples: ['tasks completed'],
  },
  {
    path: ['complete'],
    summary: 'Mark tasks completed, or sync-merge ready pull requests.',
    usage: 'tasks complete <task-id>...\n       tasks complete --sync [--apply] [--all]',
    description:
      'Two forms. With one or more task ids, marks each task completed (already-completed tasks are left unchanged; soft-deleted tasks are rejected). With --sync, walks every open pull request and reports the ones ready to merge (CI green, no unresolved review comments, no conflicts) along with the tasks they would complete; --sync is dry-run unless --apply is passed. Task ids cannot be combined with --sync, and --apply/--all only apply with --sync.',
    arguments: [
      '<task-id>: One or more task ids (or prefixes) to complete. Omit when using --sync.',
    ],
    options: [
      {
        name: '--sync',
        description:
          'Inventory open pull requests and report which are ready to merge. Read-only and dry-run by default.',
      },
      {
        name: '--apply',
        description:
          'With --sync, actually squash-merge each ready pull request (deleting its branch) and complete its tasks.',
      },
      {
        name: '--all',
        description:
          'With --sync, also merge ready pull requests that have no associated task. Does not change which tasks are completed.',
      },
    ],
    examples: [
      'tasks complete 1a2b3c4d',
      'tasks complete 1a2b3c4d 5e6f7a8b',
      'tasks complete --sync',
      'tasks complete --sync --apply',
      'tasks complete --sync --apply --all',
    ],
  },
  {
    path: ['current'],
    summary: 'Return the task assigned to the current branch.',
    usage: 'tasks current',
    description:
      'Resolves the current Git branch and returns its single active task. Returns null when no active task is assigned, and fails when multiple active tasks match.',
    examples: ['tasks current'],
  },
  {
    path: ['peek'],
    summary: 'Return the next available task.',
    usage: 'tasks peek',
    description:
      'Returns an available task, preferring tasks with plans before unplanned tasks. Prints no output when no task is available.',
    examples: ['tasks peek'],
  },
  {
    path: ['remaining'],
    summary: 'Count remaining tasks.',
    usage: 'tasks remaining',
    description:
      'Returns the number of active tasks that are not completed, in-progress, or deleted. Future-start tasks are included.',
    examples: ['tasks remaining'],
  },
  {
    path: ['repository'],
    summary: 'Show the current GitHub repository.',
    usage: 'tasks repository [--url] [--json]',
    description:
      'Returns the current GitHub repository name as a raw string by default, the full GitHub URL when --url is supplied, or a JSON object with both name and url when --json is supplied. --url and --json cannot be combined — the raw form rejects --json with json_not_supported.',
    options: [
      { name: '--url', description: 'Return the full GitHub repository URL as a raw string.' },
      { name: '--json', description: 'Return a JSON object with name and url.' },
    ],
    examples: ['tasks repository', 'tasks repository --url', 'tasks repository --json'],
  },
  {
    path: ['session'],
    summary: 'Show task agent session metadata.',
    usage: 'tasks session <task-id>',
    description: `Returns provider, session, branch, derived worktree, absolute plan path, session data path, and warnings.`,
    arguments: [requiredTaskIdArgument],
    examples: ['tasks session current', 'tasks session 8f7d6a'],
  },
  {
    path: ['progress'],
    summary: 'Inspect or record task progress.',
    usage: 'tasks progress [list|add] [options]',
    description:
      'Namespaced command for listing or recording task progress entries. With no subcommand, defaults to `tasks progress list`.',
    options: [
      {
        name: '--full',
        description: 'Show every progress entry in pretty output instead of the recent summary.',
      },
    ],
    examples: [
      'tasks progress',
      'tasks progress list',
      'tasks progress add --message "Plan approved"',
    ],
  },
  {
    path: ['progress', 'list'],
    summary: 'List progress entries for a task.',
    usage: 'tasks progress list [task-id] [--full]',
    description: `Returns chronological progress entries recorded for the task, including provider and session metadata when available. Pretty output shows the most recent entries by default; pass --full to show every entry. When task-id is omitted, resolves the active task on the current Git branch.`,
    arguments: [requiredTaskIdArgument],
    options: [
      {
        name: '--full',
        description: 'Show every progress entry in pretty output instead of the recent summary.',
      },
    ],
    examples: [
      'tasks progress',
      'tasks progress list',
      'tasks progress list --full',
      'tasks progress list current',
      'tasks progress list 8f7d6a',
    ],
  },
  {
    path: ['progress', 'add'],
    summary: 'Record task progress.',
    usage:
      'tasks progress add [task-id] --message <markdown> [--provider <claude|codex>] [--session <id>]',
    description: `Appends a progress entry to a task and moves draft or ready tasks to in-progress. When task-id is omitted, resolves the active task on the current Git branch. When --provider or --session are omitted, Scrumlord infers them in this order: SCRUMLORD_CLI, then CLAUDECODE=1 → claude, then CODEX_SESSION_ID → codex, then CLAUDE_SESSION_ID → claude, then the task's stored session when the stored provider matches. The stored session is never paired with a different provider. CLAUDE_PROJECT_DIR is used as the default cwd.`,
    arguments: [requiredTaskIdArgument],
    options: [
      { name: '--message', value: '<markdown>', description: 'Progress note to append.' },
      {
        name: '--provider',
        value: '<claude|codex>',
        description: 'Agent provider. Inferred from environment when omitted.',
      },
      {
        name: '--session',
        value: '<id>',
        description:
          'Provider-specific session identifier. Inferred from environment when omitted.',
      },
    ],
    examples: [
      'tasks progress add current --message "Wrote failing regression test"',
      'tasks progress add 8f7d6a --message "Wrote failing regression test"',
      'tasks progress add 8f7d6a --message "Blocked on CI" --provider codex --session 019e-session',
    ],
  },
  {
    path: ['clear'],
    summary: 'Clear a task property.',
    usage: 'tasks clear <branch|plan|session|start-date|due-date> [task-id]',
    description: `Clears a single nullable field on a task. Clearing session removes both provider and session together. When task-id is omitted, resolves the active task on the current Git branch.`,
    arguments: [
      '<branch|plan|session|start-date|due-date>: Property to clear.',
      requiredTaskIdArgument,
    ],
    examples: [
      'tasks clear branch current',
      'tasks clear plan 8f7d6a',
      'tasks clear session current',
      'tasks clear start-date 8f7d6a',
      'tasks clear due-date current',
    ],
  },
  {
    path: ['start'],
    summary: 'Start or resume work on a task in an agent CLI.',
    usage: 'tasks start <task-id> --cli <claude|codex>',
    description: `For a new task: moves it to in-progress, records provider/session metadata, and launches the selected agent in plan mode with task context. For an in-progress task with a recorded session: reattaches the existing provider session from the derived worktree, leaving task state untouched.`,
    arguments: [requiredTaskIdArgument],
    options: [
      {
        name: '--cli',
        value: '<claude|codex>',
        description:
          'Agent CLI to launch. Defaults to SCRUMLORD_CLI. Ignored on resume; must match the recorded provider if provided.',
      },
    ],
    examples: ['tasks start current --cli codex', 'tasks start 8f7d6a --cli codex'],
  },
  {
    path: ['pipeline'],
    summary: 'Drain the ready queue end-to-end.',
    usage:
      'tasks pipeline --cli <claude|codex> [--max <n>] [--recover[-then-run]] [--apply] [--resume <task-id>] [--dry-run] [--json] [--quiet]',
    description:
      'Claims tasks atomically, materializes worktrees, delegates each per-task run to the agent CLI, polls each pull request to merge, then continues. A single lockfile (tmp/pipeline.lock) protects against concurrent pipelines. Exit codes: 0 success, 1 stuck, 2 args/capability, 3 lock held, 4 manual recovery verdicts, 5 runtime failure, 130/143 signals.',
    options: [
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Agent CLI to launch. Defaults to SCRUMLORD_CLI.',
      },
      {
        name: '--max',
        value: '<n>',
        description: 'Stop after n claim attempts (default unlimited).',
      },
      {
        name: '--once',
        description:
          'Exit after one full task lifecycle attempt (alias for `--max 1`). Conflicts with any other --max value.',
      },
      {
        name: '--recover',
        description: 'Run only the recovery sweep and exit (annotate-only without --apply).',
      },
      {
        name: '--recover-then-run',
        description: 'Sweep first, then drain. Refuses to start if any task is resumable.',
      },
      {
        name: '--apply',
        description:
          'Mutate state during the recovery sweep. Without it, the sweep prints verdicts only.',
      },
      {
        name: '--resume',
        value: '<task-id>',
        description: 'Resume one specific in-flight task through merge and exit.',
      },
      {
        name: '--dry-run',
        description:
          'Preview a drain without writes, spawns, or lock files. Read-only GitHub queries only.',
      },
      { name: '--json', description: 'Emit the final summary as JSON on stdout.' },
      {
        name: '--quiet',
        description:
          'Suppress progress lines. Errors, warnings, recovery verdicts, and the summary always emit.',
      },
    ],
    examples: [
      'tasks pipeline --cli claude',
      'tasks pipeline --cli claude --once',
      'tasks pipeline --cli codex --max 3',
      'tasks pipeline --recover --apply',
      'tasks pipeline --resume 8f7d6a --cli codex',
    ],
  },
  {
    path: ['get'],
    summary: 'Fetch one task by ID.',
    usage: 'tasks get <task-id>',
    description: `Returns a single task or null when no matching task exists.`,
    arguments: [requiredTaskIdArgument],
    examples: ['tasks get current', 'tasks get 8f7d6a'],
  },
  {
    path: ['tagged'],
    summary: 'List tasks by tag.',
    usage: 'tasks tagged <tag...> [--all] [--planned|--unplanned] [--count]',
    description:
      'Returns tasks that contain any of the supplied tags by default, or tasks that contain every supplied tag when --all is set.',
    arguments: ['<tag...>: One or more tags.'],
    options: [
      { name: '--all', description: 'Require every supplied tag instead of any.' },
      ...taskListingOptions,
    ],
    examples: ['tasks tagged frontend backend', 'tasks tagged frontend backend --all'],
  },
  {
    path: ['with-branch'],
    summary: 'List tasks assigned to a Git branch.',
    usage: 'tasks with-branch <branch> [--planned|--unplanned] [--count]',
    description: 'Returns tasks whose branch metadata matches the supplied branch.',
    arguments: ['<branch>: Git branch name.'],
    options: taskListingOptions,
    examples: ['tasks with-branch feature/task-graph'],
  },
  {
    path: ['blocked-by'],
    summary: 'List blockers for a task.',
    usage: 'tasks blocked-by <task-id> [--planned|--unplanned] [--count]',
    description: `Returns the tasks that block the supplied task.`,
    arguments: [requiredTaskIdArgument],
    options: taskListingOptions,
    examples: ['tasks blocked-by current', 'tasks blocked-by 8f7d6a'],
  },
  {
    path: ['blocking'],
    summary: 'List tasks blocked by a task.',
    usage: 'tasks blocking <task-id> [--planned|--unplanned] [--count]',
    description: `Returns tasks that depend on the supplied task.`,
    arguments: [requiredTaskIdArgument],
    options: taskListingOptions,
    examples: ['tasks blocking current', 'tasks blocking 8f7d6a'],
  },
  {
    path: ['priority'],
    summary: 'List tasks with a priority.',
    usage: 'tasks priority <1|2|3> [--planned|--unplanned] [--count]',
    description: 'Returns tasks with the supplied priority. Higher numbers are more urgent.',
    arguments: ['<1|2|3>: Priority to match.'],
    options: taskListingOptions,
    examples: ['tasks priority 3'],
  },
  {
    path: ['status'],
    summary: 'List tasks with a status.',
    usage: 'tasks status <status> [--planned|--unplanned] [--count]',
    description: 'Returns active tasks with the supplied status.',
    arguments: ['<status>: One of draft, ready, in-progress, in-review, completed.'],
    options: taskListingOptions,
    examples: ['tasks status in-progress', 'tasks status completed --count'],
  },
  {
    path: ['create'],
    summary: 'Create a task.',
    usage: 'tasks create --title <title> [options]',
    description: 'Creates a task and returns the hydrated task as JSON.',
    options: [
      ...taskFieldOptions,
      { name: '--draft', description: 'Create the task in draft status.' },
      {
        name: '--tag',
        value: '<tag>',
        description: 'Add a tag. Can be repeated or comma-delimited.',
      },
      { name: '--tags', value: '<tag,tag>', description: 'Add comma-delimited tags.' },
      { name: '--blocked-by', value: '<task-id>', description: 'Add an initial blocker.' },
    ],
    examples: [
      'tasks create --title "Write tests" --priority 3',
      'tasks create --title "Draft proposal" --draft --tag planning',
    ],
  },
  {
    path: ['update'],
    summary: 'Update a task.',
    usage: 'tasks update <task-id> [options]',
    description: `Updates task fields and refreshes the last modified timestamp.`,
    arguments: [requiredTaskIdArgument],
    options: [
      ...taskFieldOptions,
      { name: '--deleted', value: '<true|false>', description: 'Set soft-delete state.' },
    ],
    examples: [
      'tasks update 8f7d6a --due-date 2026-05-20 --priority 2',
      'tasks update 8f7d6a --title "Write regression tests"',
      'tasks update 8f7d6a --status in-progress',
      'tasks update 8f7d6a --branch feature/x',
      'tasks update 8f7d6a --plan tmp/plans/8f7d6a.md',
    ],
  },
  {
    path: ['delete'],
    summary: 'Delete a task.',
    usage: 'tasks delete <task-id> [--hard]',
    description: `Soft-deletes by default (sets deleted=1) and removes any dependency edges that reference the task. With --hard, physically deletes the row (FK cascades remove tags, dependencies, and progress). Surviving neighbors of a deleted task receive a last-modified-at touch so consumers watching for graph changes can react.`,
    arguments: [requiredTaskIdArgument],
    options: [
      {
        name: '--hard',
        description: 'Physically remove the task and cascade related rows.',
      },
    ],
    examples: ['tasks delete current', 'tasks delete 8f7d6a', 'tasks delete 8f7d6a --hard'],
  },
  {
    path: ['tags'],
    summary: 'List tags for a task, the current project, or all projects.',
    usage: 'tasks tags [task-id] [--all]',
    description: `With a task id, returns that task's normalized tags. With no argument, lists every distinct tag in the current project. With --all (and no task id), lists distinct tags across every project in the shared database.`,
    arguments: ['[task-id]: Optional. UUID, unique prefix, "current", or "next".'],
    options: [
      { name: '--all', description: 'List tags across all projects (only with no task id).' },
    ],
    examples: ['tasks tags', 'tasks tags --all', 'tasks tags current', 'tasks tags 8f7d6a'],
  },
  {
    path: ['tags', 'add'],
    summary: 'Add a tag to a task.',
    usage: 'tasks tags add <task-id> <tag>',
    description: `Adds a normalized tag to a task.`,
    arguments: [requiredTaskIdArgument, '<tag>: Tag to add.'],
    examples: ['tasks tags add current testing', 'tasks tags add 8f7d6a testing'],
  },
  {
    path: ['tags', 'remove'],
    summary: 'Remove a tag from a task.',
    usage: 'tasks tags remove <task-id> <tag>',
    description: `Removes a normalized tag from a task.`,
    arguments: [requiredTaskIdArgument, '<tag>: Tag to remove.'],
    examples: ['tasks tags remove current testing', 'tasks tags remove 8f7d6a testing'],
  },
  {
    path: ['blockers'],
    summary: 'List blockers for a task.',
    usage: 'tasks blockers <task-id> [--planned|--unplanned] [--count]',
    description: `Returns the tasks that block the supplied task.`,
    arguments: [requiredTaskIdArgument],
    options: taskListingOptions,
    examples: ['tasks blockers current', 'tasks blockers 8f7d6a'],
  },
  {
    path: ['blockers', 'add'],
    summary: 'Add a dependency blocker.',
    usage: 'tasks blockers add <task-id> <blocked-by-task-id>',
    description: `Adds a dependency edge showing that one task is blocked by another.`,
    arguments: [requiredTaskIdArgument, '<blocked-by-task-id>: Blocking task.'],
    examples: [
      'tasks blockers add current prerequisite-id',
      'tasks blockers add feature-id prerequisite-id',
    ],
  },
  {
    path: ['blockers', 'remove'],
    summary: 'Remove a dependency blocker.',
    usage: 'tasks blockers remove <task-id> <blocked-by-task-id>',
    description: `Removes a dependency edge between two tasks.`,
    arguments: [requiredTaskIdArgument, '<blocked-by-task-id>: Blocking task.'],
    examples: [
      'tasks blockers remove current prerequisite-id',
      'tasks blockers remove feature-id prerequisite-id',
    ],
  },
  {
    path: ['overview'],
    summary: 'List open pull requests with task readiness.',
    usage: 'tasks overview [--sync] [--watch]',
    description:
      'Returns open pull requests with CI status, unresolved review comment counts, merge-conflict state, and tasks whose branch matches the pull request head branch. Human output renders as a terminal-width table. Matching active tasks move to in-review. With --sync, also runs syncGitStatus for the current branch before the per-PR iteration, and wraps output as { items, sync }. With --watch, refreshes the human dashboard every 30 seconds using the existing GitHub ETag cache. Does not perform a per-PR sync of branches you do not have checked out.',
    options: [
      {
        name: '--sync',
        description:
          'Runs syncGitStatus for the current branch in addition to the per-open-PR in-review reconciliation already performed by overview. Does not perform a per-PR sync of branches you do not have checked out.',
      },
      {
        name: '--watch',
        description:
          'Keep a terminal dashboard open and refresh it every 30 seconds. Uses cached GitHub ETags on REST calls.',
      },
    ],
    examples: ['tasks overview', 'tasks overview --sync', 'tasks overview --watch'],
  },
  {
    path: ['setup'],
    summary: 'Run Scrumlord setup.',
    usage:
      'tasks setup [--skills|--subagents|--git-hooks|--agent-hooks|--prompt|--shell] [--project|--user|--local] [--agent <all|claude|codex>] [--yes]',
    description:
      'With no mode flag, runs the interactive numbered-choice setup. With a mode flag, runs that single piece: --skills writes agent skill files; --subagents installs task-manager subagents; --git-hooks installs the Lefthook block; --agent-hooks writes lifecycle hook configuration; --prompt emits a raw setup prompt agents can follow; --shell prints the tasks-teleport and tasks-start shell helpers to stdout.',
    options: [
      { name: '--skills', description: 'Write agent skill files.' },
      { name: '--subagents', description: 'Install task-manager subagents.' },
      { name: '--git-hooks', description: 'Install managed Git hooks.' },
      { name: '--agent-hooks', description: 'Install agent lifecycle hooks.' },
      { name: '--prompt', description: 'Print a raw setup prompt for an agent.' },
      {
        name: '--shell',
        description:
          'Print the tasks-teleport and tasks-start shell helpers to stdout. Redirect into your rc file to enable `cd "$(tasks teleport current)"` and have `tasks-start` cd into the task worktree after the agent exits.',
      },
      {
        name: '--project',
        description: 'Write to the project (default for skills/subagents/git-hooks).',
      },
      {
        name: '--user',
        description: 'Write to the user home directory (default for agent-hooks).',
      },
      {
        name: '--local',
        description: 'Write to project-local Claude settings (agent-hooks only).',
      },
      { name: '--agent', description: 'Restrict to one agent: all (default), claude, or codex.' },
      { name: '--yes', description: 'Skip the interactive prompt and use defaults.' },
      { name: '--codex', description: 'Interactive setup: configure and launch Codex.' },
      { name: '--claude', description: 'Interactive setup: configure and launch Claude.' },
    ],
    examples: [
      'tasks setup',
      'tasks setup --yes',
      'tasks setup --skills --project',
      'tasks setup --subagents --agent claude',
      'tasks setup --git-hooks',
      'tasks setup --agent-hooks --user',
      'tasks setup --prompt',
      'tasks setup --shell >> ~/.zshrc',
    ],
  },
  {
    path: ['setup', 'status'],
    summary: 'Inspect Scrumlord setup state.',
    usage: 'tasks setup status',
    description:
      'Returns read-only setup state for restricted agents, including tasksExecutable, projectRoot, databaseExists, provider CLIs, subagent paths, skill paths, and hook configuration files.',
    examples: ['tasks setup status'],
  },
  {
    path: ['agent-hook'],
    summary: 'Handle an agent hook payload.',
    usage: 'tasks agent-hook <claude|codex>',
    description:
      'Internal hook entrypoint. Reads hook JSON from stdin, emits current task context for UserPromptSubmit, and exits quietly when no task can be resolved.',
    arguments: ['<claude|codex>: Agent provider that emitted the hook.'],
    examples: ['tasks agent-hook codex'],
  },
  {
    path: ['pr'],
    summary: 'Show pull request status, URL, or review comments.',
    usage:
      'tasks pr [--watch | --sync [--quiet] | --url | --open | --comments [--resolved|--all] | --poll [--max-polls <n>] [--poll-interval <s>] [--bot-patterns <regex>]]',
    description:
      'Returns the full PR readiness report by default (PR metadata, checks, review comments with bodies, readyToMerge). --watch refreshes the human-readable report every 30 seconds. --url returns the URL as a raw string; --open launches the browser; --comments returns unresolved review comments (with --resolved or --all to filter the thread state). --sync runs syncGitStatus first, then fetches PR status; output is { pullRequest, sync }. With --sync --quiet, all output is suppressed (suitable for hooks). --quiet requires --sync. --poll re-fetches until readyToMerge or --max-polls is reached; always exits 0 and signals readiness via poll.pollsExhausted and readyToMerge in the JSON output.',
    options: [
      {
        name: '--watch',
        description:
          'Refresh the human-readable pull request readiness report every 30 seconds. Cannot be combined with --json.',
      },
      { name: '--url', description: 'Return the pull request URL as a raw string.' },
      { name: '--open', description: 'Open the pull request URL in the system browser.' },
      { name: '--comments', description: 'Return review comments instead of the full report.' },
      {
        name: '--resolved',
        description: 'With --comments, return resolved review comments only.',
      },
      {
        name: '--all',
        description: 'With --comments, return every review comment regardless of thread state.',
      },
      {
        name: '--sync',
        description:
          'Run syncGitStatus first, then fetch PR status. Returns { pullRequest, sync }. Under --quiet, PR-fetch errors are swallowed so hooks degrade gracefully.',
      },
      {
        name: '--quiet',
        description: 'Suppress all output (requires --sync). Suitable for Lefthook hooks.',
      },
      {
        name: '--poll',
        description:
          'Poll until readyToMerge or --max-polls is reached. Always exits 0; branch on poll.pollsExhausted and readyToMerge. Cannot be combined with --url, --open, --sync, --quiet, or --comments.',
      },
      {
        name: '--max-polls',
        value: '<n>',
        description: 'With --poll, maximum number of fetches before giving up (default: 5).',
      },
      {
        name: '--poll-interval',
        value: '<s>',
        description: 'With --poll, seconds between fetches (default: 20).',
      },
      {
        name: '--bot-patterns',
        value: '<regex>',
        description:
          'With --poll, case-insensitive pattern matching bot check names (default: review|copilot|bugbot|coderabbit).',
      },
    ],
    examples: [
      'tasks pr',
      'tasks pr --watch',
      'tasks pr --url',
      'tasks pr --comments',
      'tasks pr --comments --all',
      'tasks pr --sync',
      'tasks pr --sync --quiet',
      'tasks pr --poll',
      'tasks pr --poll --max-polls 10 --poll-interval 15',
    ],
  },
  {
    path: ['search'],
    summary: 'Fuzzy-search tasks by title or description.',
    usage:
      'tasks search [query] [--title <text>] [--description <text>] [--all] [--planned|--unplanned] [--count]',
    description:
      'Fuzzy-searches active tasks. Provide either a positional query (matches against the combined title+description text of each task, so multi-token queries can satisfy tokens across both fields) OR --title and/or --description (each scopes the search to that column; multiple field flags intersect by task and combine scores by average). Mixing a positional query with --title or --description is rejected. Results are ranked by match score, then priority desc, then createdAt asc.',
    arguments: [
      '[query]: Positional query. Required unless --title or --description is supplied. Cannot be combined with field flags.',
    ],
    options: [
      {
        name: '--title',
        value: '<text>',
        description: 'Match only the title field. Cannot be combined with a positional query.',
      },
      {
        name: '--description',
        value: '<text>',
        description:
          'Match only the description field. Cannot be combined with a positional query.',
      },
      { name: '--all', description: 'Include soft-deleted tasks.' },
      ...taskListingOptions,
    ],
    examples: [
      'tasks search authentication',
      'tasks search --title login',
      'tasks search --description "race condition"',
      'tasks search --title login --description timeout',
      'tasks search bug --count',
      'tasks search --title cleanup --planned',
    ],
  },
  {
    path: ['prompt'],
    summary: 'Emit or launch a workflow skill (next, plan, resolve, sync, audit, merge, cleanup).',
    usage: 'tasks prompt <skill> [--print] [--cli <claude|codex>] [skill options]',
    description:
      'Runs one of the workflow skills under a single namespace. --print emits the rendered prompt to stdout; --cli <claude|codex> (or SCRUMLORD_CLI) launches that agent against it. For the pure skills (next, resolve, sync, audit, merge) a bare invocation launches the agent when SCRUMLORD_CLI is set. plan and cleanup keep their store behavior: bare "tasks prompt plan" emits planning prompts, and "tasks prompt cleanup" needs a graph selector, --print, or --cli. --cli is mutually exclusive with --print and the store/output flags. See "tasks prompt <skill> --help" for each skill.',
    arguments: ['<skill>: One of next, plan, resolve, sync, audit, merge, cleanup.'],
    options: [
      {
        name: '--print',
        description: 'Emit the rendered prompt to stdout instead of launching an agent.',
      },
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Agent CLI to launch. Defaults to SCRUMLORD_CLI. Conflicts with --print.',
      },
    ],
    examples: [
      'tasks prompt resolve --print',
      'tasks prompt next --cli claude',
      'tasks prompt plan current',
      'tasks prompt cleanup 30 --dry-run',
    ],
  },
  {
    path: ['prompt', 'next'],
    summary: 'Claim and start work on the next available task.',
    usage: 'tasks prompt next [--print] [--cli <claude|codex>]',
    description:
      'With --print, resolves the next available task read-only and emits the next skill prompt seeded with its id and title (no output when none is available). Otherwise claims the task, materializes a dedicated worktree at tmp/worktrees/tasks/<task-id>, and launches the agent.',
    options: [
      { name: '--print', description: 'Emit the prompt instead of launching.' },
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Agent CLI to launch. Defaults to SCRUMLORD_CLI.',
      },
    ],
    examples: ['tasks prompt next --print', 'tasks prompt next --cli claude'],
  },
  {
    path: ['prompt', 'plan'],
    summary: 'Emit a Markdown prompt directing an agent to author task plans.',
    usage: 'tasks prompt plan [task-id] [--all] [--print] [--cli <claude|codex>]',
    description:
      'Store mode (default): with no argument, emits a prompt to author plans for every available unplanned task; with a task id, scopes to that task. --print is identical to the bare form (output-style only). --cli launches the plan skill instead. Accepts a UUID, a unique UUID prefix, "current", or "next". plan has no JSON form.',
    arguments: ['[task-id]: Optional. UUID, unique prefix, "current", or "next".'],
    options: [
      { name: '--all', description: 'Scope to all unplanned tasks.' },
      { name: '--print', description: 'Emit to stdout (default for store mode).' },
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Launch the plan skill. Conflicts with --print.',
      },
    ],
    examples: [
      'tasks prompt plan',
      'tasks prompt plan current',
      'tasks prompt plan next',
      'tasks prompt plan 8f7d6a',
    ],
  },
  {
    path: ['prompt', 'resolve'],
    summary: 'Emit or launch the resolve workflow skill.',
    usage: 'tasks prompt resolve [--all] [--print] [--cli <claude|codex>]',
    description:
      'With --print, prints the resolve skill prompt. Otherwise launches the agent to run it. --all scopes to all matching tasks (valid in either mode).',
    options: [
      { name: '--all', description: 'Operate on all matching tasks.' },
      { name: '--print', description: 'Emit the prompt instead of launching.' },
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Agent CLI to launch. Defaults to SCRUMLORD_CLI.',
      },
    ],
    examples: [
      'tasks prompt resolve --print',
      'tasks prompt resolve --cli claude',
      'tasks prompt resolve --all --cli claude',
    ],
  },
  {
    path: ['prompt', 'sync'],
    summary: 'Emit or launch the sync workflow skill.',
    usage: 'tasks prompt sync [--print] [--cli <claude|codex>]',
    description:
      'With --print, prints the sync skill prompt. Otherwise launches the agent to run it.',
    options: [
      { name: '--print', description: 'Emit the prompt instead of launching.' },
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Agent CLI to launch. Defaults to SCRUMLORD_CLI.',
      },
    ],
    examples: ['tasks prompt sync --print', 'tasks prompt sync --cli claude'],
  },
  {
    path: ['prompt', 'audit'],
    summary: 'Emit or launch the audit workflow skill.',
    usage: 'tasks prompt audit [--print] [--cli <claude|codex>]',
    description:
      'With --print, prints the audit skill prompt. Otherwise launches the agent to run it.',
    options: [
      { name: '--print', description: 'Emit the prompt instead of launching.' },
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Agent CLI to launch. Defaults to SCRUMLORD_CLI.',
      },
    ],
    examples: ['tasks prompt audit --print', 'tasks prompt audit --cli claude'],
  },
  {
    path: ['prompt', 'merge'],
    summary: 'Emit or launch the merge workflow skill.',
    usage: 'tasks prompt merge [--print] [--cli <claude|codex>]',
    description:
      'With --print, prints the merge skill prompt. Otherwise launches the agent to run it.',
    options: [
      { name: '--print', description: 'Emit the prompt instead of launching.' },
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Agent CLI to launch. Defaults to SCRUMLORD_CLI.',
      },
    ],
    examples: ['tasks prompt merge --print', 'tasks prompt merge --cli claude'],
  },
  {
    path: ['prompt', 'cleanup'],
    summary: 'Prune the task graph, or emit/launch the worktree-cleanup skill.',
    usage:
      'tasks prompt cleanup [<days>] [--hard] [--recover-orphans] [--orphans-only] [--dry-run] [--print] [--cli <claude|codex>]',
    description:
      'Graph mode requires a selector: <days> soft-deletes aged completed tasks (--hard physically removes), --orphans-only runs only orphan recovery, --recover-orphans adds orphan recovery to aged cleanup. --dry-run previews any graph mode. With no selector, --print emits the worktree-cleanup skill prompt and --cli launches it; bare with no selector errors missing_mode. --cli conflicts with every selector/modifier. Orphan detection checks local refs and origin only.',
    arguments: [
      '<days>: Non-negative integer age threshold. Required for aged/aged-and-orphans graph modes.',
    ],
    options: [
      { name: '--hard', description: 'Physically remove matching aged tasks.' },
      {
        name: '--recover-orphans',
        description: 'Also demote in-progress tasks with missing branches back to ready.',
      },
      { name: '--orphans-only', description: 'Run only orphan recovery; omit <days>.' },
      { name: '--dry-run', description: 'Report findings without writing.' },
      { name: '--print', description: 'With no selector, emit the worktree-cleanup skill prompt.' },
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Launch the cleanup skill. Conflicts with graph flags.',
      },
    ],
    examples: [
      'tasks prompt cleanup 30',
      'tasks prompt cleanup 30 --hard',
      'tasks prompt cleanup --orphans-only --dry-run',
      'tasks prompt cleanup --print',
      'tasks prompt cleanup --cli claude',
    ],
  },
  {
    path: ['teleport'],
    summary: 'Resolve a task worktree path; cd via the tasks-teleport shell function.',
    usage: 'tasks teleport <task-id> [--print] [--json]',
    description:
      'Resolves <task-id> (UUID, unique prefix, "current", or "next") and prints the absolute path of its existing git worktree on stdout, newline-terminated. A child process cannot change the parent shell directory, so the actual cd happens in the tasks-teleport shell function (install with "tasks setup --shell"). With --print the binary stays silent on stderr — this is the path the shell function consumes. Without --print, and when the shell function is not installed, a one-line advisory is written to stderr (stdout stays path-only). Never creates a worktree. On error, --json forces the JSON error envelope; success output is always the raw path.',
    arguments: ['<task-id>: UUID, unique UUID prefix, "current", or "next".'],
    options: [
      {
        name: '--print',
        description: 'Print the bare path only; suppress the shell-function advisory.',
      },
      {
        name: '--json',
        description: 'Force the error envelope to JSON. Does not affect success output.',
      },
    ],
    examples: [
      'tasks setup --shell >> ~/.zshrc   # install tasks-teleport, then: tasks-teleport current',
      'cd "$(tasks teleport current --print)"',
      'cd "$(tasks teleport next --print)"',
    ],
  },
  {
    path: ['completions'],
    summary: 'Generate shell completion scripts for the tasks CLI.',
    usage: 'tasks completions <shell> [--install [--path <path>] [--force]]',
    description:
      'Generates a shell completion script for bash or zsh. By default the script is printed to stdout — redirect it into the appropriate completions directory, or pass --install to write the file automatically.\n\nThe generated script calls `tasks completions-data ids|tags` to dynamically complete task IDs and tag names. This helper is internal and not intended for direct use.',
    arguments: ['<shell>: Shell to generate completions for. Supported values: bash, zsh.'],
    options: [
      { name: '--install', description: 'Write the script to the default location for the shell.' },
      {
        name: '--path',
        value: '<path>',
        description: 'Override the default install location (requires --install).',
      },
      {
        name: '--force',
        description: 'Overwrite an existing completion file (requires --install).',
      },
    ],
    examples: [
      'tasks completions zsh > "${fpath[1]}/_tasks"',
      'tasks completions bash | sudo tee /etc/bash_completion.d/tasks',
      'tasks completions zsh --install',
      'tasks completions bash --install --path ~/.bash_completion.d/tasks',
    ],
  },
];

export const helpTopics = topics.map((topic) => topic.path.join(' '));

const topicByPath = new Map(topics.map((topic) => [topic.path.join(' '), topic]));

const rows = (entries: [string, string][], theme: Theme): string[] => {
  const width = Math.max(...entries.map(([name]) => name.length));
  return entries.map(
    ([name, description]) => `  ${theme.command(name.padEnd(width))}  ${description}`,
  );
};

const formatOption = (option: HelpOption, theme: Theme): [string, string] => [
  `${option.name}${option.value ? ` ${theme.argument(option.value)}` : ''}`,
  option.description,
];

const section = (title: string, lines: string[], theme: Theme): string[] => {
  return ['', theme.heading(title), ...lines];
};

const renderMainHelp = (theme: Theme): string => {
  const commandRows = rows(
    topics
      .filter((topic) => topic.path.length === 1)
      .map((topic) => [topic.path.join(' '), topic.summary]),
    theme,
  );
  return [
    theme.title('Scrumlord Tasks CLI'),
    '',
    'Usage:',
    `  ${theme.command('tasks')} ${theme.argument('<command>')} ${theme.muted('[options]')}`,
    `  ${theme.command('tasks')} ${theme.argument('<command>')} ${theme.option('--help')}`,
    ...section('Commands:', commandRows, theme),
    ...section(
      'Global Options:',
      rows(
        globalOptions.map((option) => formatOption(option, theme)),
        theme,
      ),
      theme,
    ),
    '',
    theme.muted('All data commands return JSON. Help output is colorized for humans.'),
  ].join('\n');
};

const renderTopicHelp = (topic: HelpTopic, theme: Theme): string => {
  const lines = [
    theme.title(`tasks ${topic.path.join(' ')}`),
    '',
    topic.summary,
    '',
    'Usage:',
    `  ${theme.command(topic.usage)}`,
    '',
    topic.description,
  ];

  if (topic.arguments?.length)
    lines.push(
      ...section(
        'Arguments:',
        topic.arguments.map((value) => `  ${value}`),
        theme,
      ),
    );
  const options = [...globalOptions, ...(topic.options ?? [])];
  if (options.length) {
    lines.push(
      ...section(
        'Options:',
        rows(
          options.map((option) => formatOption(option, theme)),
          theme,
        ),
        theme,
      ),
    );
  }
  if (topic.examples?.length) {
    lines.push(
      ...section(
        'Examples:',
        topic.examples.map((value) => `  ${theme.command(value)}`),
        theme,
      ),
    );
  }

  return lines.join('\n');
};

/** Renders colorized CLI help for the main command or a specific command path. */
export const renderHelp = (path: string[] = [], colorMode: ColorMode = 'auto'): string | null => {
  const theme = createTheme(colorMode);
  if (path.length === 0) return `${renderMainHelp(theme)}\n`;
  const topic = topicByPath.get(path.join(' '));
  return topic ? `${renderTopicHelp(topic, theme)}\n` : null;
};
