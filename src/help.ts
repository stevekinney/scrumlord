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

const inferredTaskIdDescription =
  'When omitted, Scrumlord uses the single active task assigned to the current Git branch.';
const optionalTaskIdArgument = `[task-id]: Optional task ID. ${inferredTaskIdDescription}`;

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
    usage: 'tasks list [--all] [--planned|--unplanned] [--count]',
    description:
      'Returns active tasks by default. Use --all to include soft-deleted tasks when reconciling long documents against the full graph.',
    options: [{ name: '--all', description: 'Include soft-deleted tasks.' }, ...taskListingOptions],
    examples: ['tasks list', 'tasks list --all'],
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
    path: ['current-task'],
    summary: 'Return the task assigned to the current branch.',
    usage: 'tasks current-task',
    description:
      'Resolves the current Git branch and returns its single active task. Returns null when no active task is assigned, and fails when multiple active tasks match.',
    examples: ['tasks current-task'],
  },
  {
    path: ['next'],
    summary: 'Return the next available task.',
    usage: 'tasks next',
    description:
      'Returns an available task, preferring tasks with plans before unplanned tasks. Prints no output when no task is available.',
    examples: ['tasks next'],
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
      'Returns the current GitHub repository name as a raw string by default, the full GitHub URL when --url is supplied, or a JSON object with both name and url when --json is supplied. --json overrides --url when both are given.',
    options: [
      { name: '--url', description: 'Return the full GitHub repository URL as a raw string.' },
      { name: '--json', description: 'Return a JSON object with name and url.' },
    ],
    examples: ['tasks repository', 'tasks repository --url', 'tasks repository --json'],
  },
  {
    path: ['session'],
    summary: 'Show task agent session metadata.',
    usage: 'tasks session [task-id]',
    description: `Returns provider, session, branch, derived worktree, plan path, session data path, and warnings. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    examples: ['tasks session', 'tasks session 8f7d6a'],
  },
  {
    path: ['progress'],
    summary: 'List progress entries for a task.',
    usage: 'tasks progress [task-id]',
    description: `Returns chronological progress entries recorded for the task, including provider and session metadata when available. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    examples: ['tasks progress', 'tasks progress 8f7d6a'],
  },
  {
    path: ['start'],
    summary: 'Start work on a task in an agent CLI.',
    usage: 'tasks start [task-id] --cli <claude|codex>',
    description: `Moves a startable task to in-progress, records provider/session metadata, and launches the selected agent in plan mode with task context. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    options: [
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Agent CLI to launch. Defaults to SCRUMLORD_CLI.',
      },
    ],
    examples: ['tasks start --cli codex', 'tasks start 8f7d6a --cli codex'],
  },
  {
    path: ['resume'],
    summary: 'Resume a task agent session.',
    usage: 'tasks resume [task-id]',
    description: `Launches the provider-specific resume command for the task session from the derived worktree when available. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    examples: ['tasks resume', 'tasks resume 8f7d6a'],
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
    usage: 'tasks get [task-id]',
    description: `Returns a single task or null when no matching task exists. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    examples: ['tasks get', 'tasks get 8f7d6a'],
  },
  {
    path: ['with-tag'],
    summary: 'List tasks with one tag.',
    usage: 'tasks with-tag <tag> [--planned|--unplanned] [--count]',
    description: 'Returns tasks containing the normalized tag.',
    arguments: ['<tag>: Tag to match.'],
    options: taskListingOptions,
    examples: ['tasks with-tag testing'],
  },
  {
    path: ['with-all-tags'],
    summary: 'List tasks containing every supplied tag.',
    usage: 'tasks with-all-tags <tag...> [--planned|--unplanned] [--count]',
    description: 'Returns tasks that contain all provided tags.',
    arguments: ['<tag...>: One or more tags.'],
    options: taskListingOptions,
    examples: ['tasks with-all-tags frontend testing'],
  },
  {
    path: ['with-any-tag'],
    summary: 'List tasks containing any supplied tag.',
    usage: 'tasks with-any-tag <tag...> [--planned|--unplanned] [--count]',
    description: 'Returns tasks that contain at least one provided tag.',
    arguments: ['<tag...>: One or more tags.'],
    options: taskListingOptions,
    examples: ['tasks with-any-tag frontend backend'],
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
    usage: 'tasks blocked-by [task-id] [--planned|--unplanned] [--count]',
    description: `Returns the tasks that block the supplied task. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    options: taskListingOptions,
    examples: ['tasks blocked-by', 'tasks blocked-by 8f7d6a'],
  },
  {
    path: ['blocking'],
    summary: 'List tasks blocked by a task.',
    usage: 'tasks blocking [task-id] [--planned|--unplanned] [--count]',
    description: `Returns tasks that depend on the supplied task. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    options: taskListingOptions,
    examples: ['tasks blocking', 'tasks blocking 8f7d6a'],
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
    path: ['with-priority'],
    summary: 'Alias for tasks priority.',
    usage: 'tasks with-priority <1|2|3> [--planned|--unplanned] [--count]',
    description: 'Returns tasks with the supplied priority.',
    arguments: ['<1|2|3>: Priority to match.'],
    options: taskListingOptions,
    examples: ['tasks with-priority 2'],
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
    usage: 'tasks update [task-id] [options]',
    description: `Updates task fields and refreshes the last modified timestamp. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    options: [
      ...taskFieldOptions,
      { name: '--deleted', value: '<true|false>', description: 'Set soft-delete state.' },
    ],
    examples: [
      'tasks update 8f7d6a --due-date 2026-05-20 --priority 2',
      'tasks update 8f7d6a --title "Write regression tests"',
    ],
  },
  {
    path: ['set-status'],
    summary: 'Transition a task status.',
    usage: 'tasks set-status [task-id] <status>',
    description: `Sets a task status to draft, ready, in-progress, in-review, or completed and refreshes the last modified timestamp. ${inferredTaskIdDescription}`,
    arguments: [
      optionalTaskIdArgument,
      '<status>: New status: draft, ready, in-progress, in-review, or completed.',
    ],
    examples: [
      'tasks set-status in-progress',
      'tasks set-status 8f7d6a in-progress',
      'tasks set-status 8f7d6a completed',
    ],
  },
  {
    path: ['set-branch'],
    summary: 'Assign a task branch.',
    usage: 'tasks set-branch [task-id] <branch>',
    description: `Sets the Git branch associated with a task and moves draft or ready tasks to in-progress. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument, '<branch>: Git branch name.'],
    examples: ['tasks set-branch feature/task-graph', 'tasks set-branch 8f7d6a feature/task-graph'],
  },
  {
    path: ['clear-branch'],
    summary: 'Clear a task branch.',
    usage: 'tasks clear-branch [task-id]',
    description: `Clears the Git branch associated with a task. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    examples: ['tasks clear-branch', 'tasks clear-branch 8f7d6a'],
  },
  {
    path: ['set-plan'],
    summary: 'Assign a task plan path.',
    usage: 'tasks set-plan [task-id] <path>',
    description: `Sets the task plan path, storing project-local paths relative to the project root. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument, '<path>: Plan file path.'],
    examples: [
      'tasks set-plan tmp/tasks/8f7d6a/PLAN.md',
      'tasks set-plan 8f7d6a tmp/tasks/8f7d6a/PLAN.md',
    ],
  },
  {
    path: ['clear-plan'],
    summary: 'Clear a task plan path.',
    usage: 'tasks clear-plan [task-id]',
    description: `Clears the task plan path. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    examples: ['tasks clear-plan', 'tasks clear-plan 8f7d6a'],
  },
  {
    path: ['set-session'],
    summary: 'Assign task session metadata.',
    usage: 'tasks set-session [task-id] <claude|codex> <session-id>',
    description: `Sets provider and session metadata for a task. ${inferredTaskIdDescription}`,
    arguments: [
      optionalTaskIdArgument,
      '<claude|codex>: Agent provider.',
      '<session-id>: Provider-specific session identifier.',
    ],
    examples: [
      'tasks set-session codex 019e-session',
      'tasks set-session 8f7d6a codex 019e-session',
    ],
  },
  {
    path: ['clear-session'],
    summary: 'Clear task session metadata.',
    usage: 'tasks clear-session [task-id]',
    description: `Clears provider and session metadata for a task. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    examples: ['tasks clear-session', 'tasks clear-session 8f7d6a'],
  },
  {
    path: ['add-progress'],
    summary: 'Record task progress.',
    usage:
      'tasks add-progress [task-id] --message <markdown> [--provider <claude|codex>] [--session <id>]',
    description: `Appends a progress entry to a task and moves draft or ready tasks to in-progress. When provider or session are omitted, Scrumlord uses the task session metadata if it exists. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    options: [
      { name: '--message', value: '<markdown>', description: 'Progress note to append.' },
      {
        name: '--provider',
        value: '<claude|codex>',
        description: 'Agent provider responsible for the progress entry.',
      },
      { name: '--session', value: '<id>', description: 'Provider-specific session identifier.' },
    ],
    examples: [
      'tasks add-progress --message "Wrote failing regression test"',
      'tasks add-progress 8f7d6a --message "Wrote failing regression test"',
      'tasks add-progress 8f7d6a --message "Blocked on CI" --provider codex --session 019e-session',
    ],
  },
  {
    path: ['delete'],
    summary: 'Soft-delete a task.',
    usage: 'tasks delete [task-id]',
    description: `Marks a task as deleted without removing it from the database. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument],
    examples: ['tasks delete', 'tasks delete 8f7d6a'],
  },
  {
    path: ['add-tag'],
    summary: 'Add a tag to a task.',
    usage: 'tasks add-tag [task-id] <tag>',
    description: `Adds a normalized tag to a task. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument, '<tag>: Tag to add.'],
    examples: ['tasks add-tag testing', 'tasks add-tag 8f7d6a testing'],
  },
  {
    path: ['remove-tag'],
    summary: 'Remove a tag from a task.',
    usage: 'tasks remove-tag [task-id] <tag>',
    description: `Removes a normalized tag from a task. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument, '<tag>: Tag to remove.'],
    examples: ['tasks remove-tag testing', 'tasks remove-tag 8f7d6a testing'],
  },
  {
    path: ['add-blocker'],
    summary: 'Add a dependency blocker.',
    usage: 'tasks add-blocker [task-id] <blocked-by-task-id>',
    description: `Adds a dependency edge showing that one task is blocked by another. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument, '<blocked-by-task-id>: Blocking task.'],
    examples: ['tasks add-blocker prerequisite-id', 'tasks add-blocker feature-id prerequisite-id'],
  },
  {
    path: ['remove-blocker'],
    summary: 'Remove a dependency blocker.',
    usage: 'tasks remove-blocker [task-id] <blocked-by-task-id>',
    description: `Removes a dependency edge between two tasks. ${inferredTaskIdDescription}`,
    arguments: [optionalTaskIdArgument, '<blocked-by-task-id>: Blocking task.'],
    examples: [
      'tasks remove-blocker prerequisite-id',
      'tasks remove-blocker feature-id prerequisite-id',
    ],
  },
  {
    path: ['cleanup'],
    summary: 'Remove old completed or soft-deleted tasks.',
    usage: 'tasks cleanup <days>',
    description:
      'Soft-deletes aged completed tasks by default, or physically removes completed and soft-deleted tasks (with FK cascades) when --hard is supplied. The age cutoff is the supplied number of days.',
    arguments: ['<days>: Non-negative integer age threshold.'],
    examples: ['tasks cleanup 30'],
  },
  {
    path: ['sync-git-status'],
    summary: 'Synchronize branch-bound tasks with Git and GitHub.',
    usage: 'tasks sync-git-status [--quiet]',
    description:
      'Moves draft or ready branch tasks to in-progress, open pull request tasks to in-review, and merged pull request tasks to completed.',
    options: [{ name: '--quiet', description: 'Suppress JSON output for hook usage.' }],
    examples: ['tasks sync-git-status', 'tasks sync-git-status --quiet'],
  },
  {
    path: ['overview'],
    summary: 'List open pull requests with task readiness.',
    usage: 'tasks overview',
    description:
      'Returns open pull requests with CI status, unresolved review comment counts, and tasks whose branch matches the pull request head branch. Matching active tasks move to in-review.',
    examples: ['tasks overview'],
  },
  {
    path: ['setup-skills'],
    summary: 'Write local agent skills.',
    usage: 'tasks setup-skills <codex|claude|cursor|--all>',
    description: 'Writes local guidance files that teach agents how to use the tasks CLI.',
    arguments: ['<codex|claude|cursor|--all>: Skill target.'],
    options: [{ name: '--all', description: 'Write Codex, Claude, and Cursor skills.' }],
    examples: ['tasks setup-skills codex', 'tasks setup-skills --all'],
  },
  {
    path: ['setup'],
    summary: 'Run full Scrumlord project setup.',
    usage: 'tasks setup [--yes|--codex|--claude] [--local|--global]',
    description:
      'Initializes the database, writes provider skills, installs task-manager subagents, configures agent hooks for selected providers, and installs managed Git hooks when Lefthook is present. Without --yes or a provider flag, runs a colorized numbered-choice setup prompt.',
    options: [
      { name: '--yes', description: 'Use sensible defaults for installed providers.' },
      {
        name: '--codex',
        description: 'Configure Codex and launch codex with setup context after setup.',
      },
      {
        name: '--claude',
        description: 'Configure Claude and launch claude with setup context after setup.',
      },
      { name: '--local', description: 'Write project-local subagents. This is the default.' },
      { name: '--global', description: 'Write user-global subagents.' },
    ],
    examples: ['tasks setup --yes', 'tasks setup --codex', 'tasks setup'],
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
    path: ['setup-subagents'],
    summary: 'Install task-manager subagents.',
    usage: 'tasks setup-subagents [codex|claude|--all] [--local|--global]',
    description:
      'Writes Scrumlord task-manager subagents for Codex and Claude. With no provider argument, only installed providers are configured. Requested providers must be available in PATH.',
    arguments: ['[codex|claude|--all]: Provider target. Defaults to installed providers.'],
    options: [
      { name: '--all', description: 'Install Codex and Claude subagents.' },
      { name: '--local', description: 'Write project-local subagents. This is the default.' },
      { name: '--global', description: 'Write user-global subagents.' },
    ],
    examples: [
      'tasks setup-subagents',
      'tasks setup-subagents codex',
      'tasks setup-subagents --all',
    ],
  },
  {
    path: ['setup-git-hooks'],
    summary: 'Install managed Git status hooks.',
    usage: 'tasks setup-git-hooks',
    description:
      'Adds Scrumlord synchronization jobs to an existing Lefthook configuration and installs the hooks.',
    examples: ['tasks setup-git-hooks'],
  },
  {
    path: ['setup-agent-hooks'],
    summary: 'Install global agent lifecycle hooks.',
    usage: 'tasks setup-agent-hooks',
    description:
      'Writes global Claude and Codex hook configuration that calls `tasks agent-hook` directly. Hooks synchronize task plans, sessions, branches, and pull request lifecycle state, and inject the inferred current branch task on user prompts. Idempotent; migrates legacy `bun run scrumlord-agent-hook.ts` entries on each run.',
    examples: ['tasks setup-agent-hooks'],
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
    summary: 'Show the current branch pull request URL.',
    usage: 'tasks pr [--url|--open]',
    description: 'Finds the open pull request for the current branch using gh.',
    options: [
      { name: '--url', description: 'Print the pull request URL. This is the default.' },
      { name: '--open', description: 'Open the pull request URL in the system browser.' },
    ],
    examples: ['tasks pr', 'tasks pr --open'],
  },
  {
    path: ['pr', 'status'],
    summary: 'Report current pull request readiness.',
    usage: 'tasks pr status',
    description:
      'Reports unresolved review comments, pending checks, failed checks, and readyToMerge for the current branch pull request.',
    examples: ['tasks pr status'],
  },
  {
    path: ['comments'],
    summary: 'List unresolved pull request review comments.',
    usage: 'tasks comments',
    description: 'Returns unresolved review comments for the current branch pull request.',
    examples: ['tasks comments'],
  },
  {
    path: ['ci'],
    summary: 'Show pull request check status.',
    usage: 'tasks ci',
    description: 'Returns gh pull request check status for the current branch pull request.',
    examples: ['tasks ci'],
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
