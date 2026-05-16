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

const requiredTaskIdArgument =
  '<task-id>: Task ID. Accepts a UUID, "current" (the active task on the current Git branch), or "next" (the next claimable task).';

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
    path: ['current'],
    summary: 'Return the task assigned to the current branch.',
    usage: 'tasks current',
    description:
      'Resolves the current Git branch and returns its single active task. Returns null when no active task is assigned, and fails when multiple active tasks match.',
    examples: ['tasks current'],
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
    usage: 'tasks session <task-id>',
    description: `Returns provider, session, branch, derived worktree, absolute plan path, session data path, and warnings.`,
    arguments: [requiredTaskIdArgument],
    examples: ['tasks session current', 'tasks session 8f7d6a'],
  },
  {
    path: ['progress'],
    summary: 'Inspect or record task progress.',
    usage: 'tasks progress <list|add> [options]',
    description:
      'Namespaced command for listing or recording task progress entries. Use `tasks progress list` to view entries and `tasks progress add` to append a new one.',
    examples: ['tasks progress list', 'tasks progress add --message "Plan approved"'],
  },
  {
    path: ['progress', 'list'],
    summary: 'List progress entries for a task.',
    usage: 'tasks progress list [task-id]',
    description: `Returns chronological progress entries recorded for the task, including provider and session metadata when available. When task-id is omitted, resolves the active task on the current Git branch.`,
    arguments: [requiredTaskIdArgument],
    examples: ['tasks progress list', 'tasks progress list current', 'tasks progress list 8f7d6a'],
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
    summary: 'Start work on a task in an agent CLI.',
    usage: 'tasks start <task-id> --cli <claude|codex>',
    description: `Moves a startable task to in-progress, records provider/session metadata, and launches the selected agent in plan mode with task context.`,
    arguments: [requiredTaskIdArgument],
    options: [
      {
        name: '--cli',
        value: '<claude|codex>',
        description: 'Agent CLI to launch. Defaults to SCRUMLORD_CLI.',
      },
    ],
    examples: ['tasks start current --cli codex', 'tasks start 8f7d6a --cli codex'],
  },
  {
    path: ['resume'],
    summary: 'Resume a task agent session.',
    usage: 'tasks resume <task-id>',
    description: `Launches the provider-specific resume command for the task session from the derived worktree when available.`,
    arguments: [requiredTaskIdArgument],
    examples: ['tasks resume current', 'tasks resume 8f7d6a'],
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
    path: ['add-tag'],
    summary: 'Add a tag to a task.',
    usage: 'tasks add-tag <task-id> <tag>',
    description: `Adds a normalized tag to a task.`,
    arguments: [requiredTaskIdArgument, '<tag>: Tag to add.'],
    examples: ['tasks add-tag current testing', 'tasks add-tag 8f7d6a testing'],
  },
  {
    path: ['remove-tag'],
    summary: 'Remove a tag from a task.',
    usage: 'tasks remove-tag <task-id> <tag>',
    description: `Removes a normalized tag from a task.`,
    arguments: [requiredTaskIdArgument, '<tag>: Tag to remove.'],
    examples: ['tasks remove-tag current testing', 'tasks remove-tag 8f7d6a testing'],
  },
  {
    path: ['add-blocker'],
    summary: 'Add a dependency blocker.',
    usage: 'tasks add-blocker <task-id> <blocked-by-task-id>',
    description: `Adds a dependency edge showing that one task is blocked by another.`,
    arguments: [requiredTaskIdArgument, '<blocked-by-task-id>: Blocking task.'],
    examples: [
      'tasks add-blocker current prerequisite-id',
      'tasks add-blocker feature-id prerequisite-id',
    ],
  },
  {
    path: ['remove-blocker'],
    summary: 'Remove a dependency blocker.',
    usage: 'tasks remove-blocker <task-id> <blocked-by-task-id>',
    description: `Removes a dependency edge between two tasks.`,
    arguments: [requiredTaskIdArgument, '<blocked-by-task-id>: Blocking task.'],
    examples: [
      'tasks remove-blocker current prerequisite-id',
      'tasks remove-blocker feature-id prerequisite-id',
    ],
  },
  {
    path: ['cleanup'],
    summary: 'Remove old completed or soft-deleted tasks.',
    usage: 'tasks cleanup <days> [--hard]',
    description:
      'Soft-deletes aged completed tasks by default (sets deleted=1 and clears their dependency edges, touching surviving neighbors). With --hard, physically removes completed and soft-deleted tasks via FK cascades, also touching surviving neighbors.',
    arguments: ['<days>: Non-negative integer age threshold.'],
    options: [
      {
        name: '--hard',
        description: 'Physically remove matching tasks and cascade related rows.',
      },
    ],
    examples: ['tasks cleanup 30', 'tasks cleanup 30 --hard'],
  },
  {
    path: ['overview'],
    summary: 'List open pull requests with task readiness.',
    usage: 'tasks overview [--sync]',
    description:
      'Returns open pull requests with CI status, unresolved review comment counts, and tasks whose branch matches the pull request head branch. Matching active tasks move to in-review. With --sync, also runs syncGitStatus for the current branch before the per-PR iteration, and wraps output as { items, sync }. Does not perform a per-PR sync of branches you do not have checked out.',
    options: [
      {
        name: '--sync',
        description:
          'Runs syncGitStatus for the current branch in addition to the per-open-PR in-review reconciliation already performed by overview. Does not perform a per-PR sync of branches you do not have checked out.',
      },
    ],
    examples: ['tasks overview', 'tasks overview --sync'],
  },
  {
    path: ['setup'],
    summary: 'Run Scrumlord setup.',
    usage:
      'tasks setup [--skills|--subagents|--git-hooks|--agent-hooks|--prompt] [--project|--user|--local] [--agent <all|claude|codex>] [--yes]',
    description:
      'With no mode flag, runs the interactive numbered-choice setup. With a mode flag, runs that single piece: --skills writes agent skill files; --subagents installs task-manager subagents; --git-hooks installs the Lefthook block; --agent-hooks writes lifecycle hook configuration; --prompt emits a raw setup prompt agents can follow.',
    options: [
      { name: '--skills', description: 'Write agent skill files.' },
      { name: '--subagents', description: 'Install task-manager subagents.' },
      { name: '--git-hooks', description: 'Install managed Git hooks.' },
      { name: '--agent-hooks', description: 'Install agent lifecycle hooks.' },
      { name: '--prompt', description: 'Print a raw setup prompt for an agent.' },
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
      'tasks pr [--sync [--quiet] | --url | --open | --comments [--resolved|--all] | --poll [--max-polls <n>] [--poll-interval <s>] [--bot-patterns <regex>]]',
    description:
      'Returns the full PR readiness report by default (PR metadata, checks, review comments with bodies, readyToMerge). --url returns the URL as a raw string; --open launches the browser; --comments returns unresolved review comments (with --resolved or --all to filter the thread state). --sync runs syncGitStatus first, then fetches PR status; output is { pullRequest, sync }. With --sync --quiet, all output is suppressed (suitable for hooks). --quiet requires --sync. --poll re-fetches until readyToMerge or --max-polls is reached; always exits 0 and signals readiness via poll.pollsExhausted and readyToMerge in the JSON output.',
    options: [
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
      'tasks pr --url',
      'tasks pr --comments',
      'tasks pr --comments --all',
      'tasks pr --sync',
      'tasks pr --sync --quiet',
      'tasks pr --poll',
      'tasks pr --poll --max-polls 10 --poll-interval 15',
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
