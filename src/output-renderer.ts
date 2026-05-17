import { createTheme, type ColorMode, type Theme } from './color.js';
import { formatJson } from './output-json.js';
import { renderReadiness, type DataShape } from './output-contracts.js';
import type { PullRequestStatusReport, ReviewComment } from './github.js';
import type { PullRequestOverviewItem } from './tasks-overview.js';
import type {
  PersistedTaskSession,
  Task,
  TaskPriority,
  TaskProgress,
  TaskStatus,
} from './types.js';

/** Context passed to every pretty renderer. */
export type RenderContext = {
  theme: Theme;
  colorMode: ColorMode;
  terminalWidth: number;
  flags: ReadonlySet<string>;
  countLabel?: string;
};

/** Construction helper. Keeps boundary defaults (width 100) in one place. */
export const createRenderContext = (input: {
  colorMode: ColorMode;
  terminalWidth?: number;
  flags: ReadonlySet<string>;
  countLabel?: string;
}): RenderContext => ({
  theme: createTheme(input.colorMode),
  colorMode: input.colorMode,
  terminalWidth: input.terminalWidth ?? 100,
  flags: input.flags,
  ...(input.countLabel !== undefined ? { countLabel: input.countLabel } : {}),
});

type PrettyRenderer = (value: unknown, context: RenderContext) => string;

const isTask = (value: unknown): value is Task =>
  typeof value === 'object' && value !== null && 'id' in value && 'title' in value;

const isTaskArray = (value: unknown): value is Task[] =>
  Array.isArray(value) && value.every((item) => isTask(item));

const isCountShape = (value: unknown): value is { count: number } =>
  typeof value === 'object' &&
  value !== null &&
  'count' in value &&
  typeof (value as { count: unknown }).count === 'number';

const statusColor = (theme: Theme, status: TaskStatus): ((text: string) => string) => {
  if (status === 'ready') return theme.success;
  if (status === 'in-progress') return theme.heading;
  if (status === 'in-review') return theme.warning;
  return theme.muted;
};

const priorityColor = (theme: Theme, priority: TaskPriority): ((text: string) => string) => {
  if (priority === 1) return theme.warning;
  if (priority === 2) return theme.heading;
  return theme.muted;
};

const truncate = (value: string, width: number): string => {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
};

const padEnd = (value: string, width: number): string =>
  value + ' '.repeat(Math.max(0, width - value.length));

const STATUS_WIDTH = Math.max(
  ...['draft', 'ready', 'in-progress', 'in-review', 'completed'].map((s) => s.length),
);
const MAX_LIST_ROWS = 50;
const ID_PREFIX_LENGTH = 8;

const renderTaskRow = (task: Task, theme: Theme, titleWidth: number): string => {
  const id = theme.muted(task.id.slice(0, ID_PREFIX_LENGTH));
  const status = statusColor(theme, task.status)(padEnd(task.status, STATUS_WIDTH));
  const priority = priorityColor(theme, task.priority)(`P${task.priority}`);
  const title = truncate(task.title, titleWidth);
  const tags = task.tags.length > 0 ? `  ${theme.muted(task.tags.join(','))}` : '';
  return `${id}  ${status}  ${priority}  ${title}${tags}`;
};

const renderTaskList = (value: unknown, context: RenderContext): string => {
  const { theme, terminalWidth, countLabel } = context;
  if (isCountShape(value)) {
    const label = countLabel ?? 'tasks';
    return `${theme.bold(String(value.count))} ${label}\n`;
  }
  if (!isTaskArray(value)) return formatJson(value);
  if (value.length === 0) return `${theme.muted('(no matching tasks)')}\n`;

  const overhead = ID_PREFIX_LENGTH + 2 + STATUS_WIDTH + 2 + 2 + 2;
  const titleWidth = Math.max(20, terminalWidth - overhead);

  const visible = value.slice(0, MAX_LIST_ROWS);
  const rows = visible.map((task) => renderTaskRow(task, theme, titleWidth));

  if (value.length > MAX_LIST_ROWS) {
    rows.push(
      theme.muted(`\nshowing ${MAX_LIST_ROWS} of ${value.length} — pass --json for the full list`),
    );
    return `${rows.join('\n')}\n`;
  }

  const label = countLabel ?? 'task(s)';
  rows.push(theme.muted(`\n${value.length} ${label}`));
  return `${rows.join('\n')}\n`;
};

const formatField = (theme: Theme, value: string | null, fallback = '(none)'): string =>
  value === null || value === '' ? theme.muted(fallback) : value;

const formatList = (theme: Theme, values: readonly string[]): string =>
  values.length === 0 ? theme.muted('(none)') : values.join(', ');

const renderTaskDescription = (theme: Theme, description: string): string => {
  if (!description.trim()) return '';
  const lines = description.split('\n');
  const visible = lines.slice(0, 8);
  const indented = visible.map((line) => `  ${line}`).join('\n');
  if (lines.length > 8) {
    return `\n\n${theme.muted('description:')}\n${indented}\n${theme.muted(`  (… ${lines.length - 8} more lines — pass --json)`)}\n`;
  }
  return `\n\n${theme.muted('description:')}\n${indented}\n`;
};

const taskFieldRows = (task: Task, theme: Theme): ReadonlyArray<readonly [string, string]> => [
  ['id', task.id],
  ['title', task.title],
  ['status', statusColor(theme, task.status)(task.status)],
  ['priority', priorityColor(theme, task.priority)(`P${task.priority}`)],
  ['branch', formatField(theme, task.branch)],
  ['plan', formatField(theme, task.plan)],
  ['tags', formatList(theme, task.tags)],
  ['blocked by', formatList(theme, task.blockedBy)],
  ['blocking', formatList(theme, task.blocking)],
  [
    'session',
    task.provider !== null || task.session !== null
      ? `${task.provider ?? '?'}:${task.session ?? '?'}`
      : theme.muted('(none)'),
  ],
  ['created', theme.muted(task.createdAt)],
  ['modified', theme.muted(task.lastModifiedAt)],
];

const renderKeyValueBlock = (
  entries: ReadonlyArray<readonly [string, string]>,
  theme: Theme,
): string => {
  const keyWidth = Math.max(...entries.map(([key]) => key.length));
  return entries
    .map(([key, value]) => `${theme.muted(key.padStart(keyWidth))}  ${value}`)
    .join('\n');
};

const renderSingleTask = (value: unknown, context: RenderContext): string => {
  const { theme } = context;
  if (value === null) return `${theme.muted('(no task)')}\n`;
  if (!isTask(value)) return formatJson(value);
  const block = renderKeyValueBlock(taskFieldRows(value, theme), theme);
  const description = renderTaskDescription(theme, value.description);
  return `${block}${description}\n`;
};

const renderRemaining = (value: unknown, context: RenderContext): string => {
  if (typeof value !== 'number') return formatJson(value);
  return `${context.theme.bold(String(value))} remaining\n`;
};

const renderCleanup = (value: unknown, context: RenderContext): string => {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { deleted?: unknown }).deleted !== 'number'
  ) {
    return formatJson(value);
  }
  const count = (value as { deleted: number }).deleted;
  const color = count > 0 ? context.theme.success : context.theme.muted;
  return `${color(`cleaned up ${count} task(s)`)}\n`;
};

const MAX_PROGRESS_ROWS = 10;

const isTaskProgress = (value: unknown): value is TaskProgress =>
  typeof value === 'object' &&
  value !== null &&
  'message' in value &&
  'createdAt' in value &&
  'taskId' in value;

const isTaskProgressArray = (value: unknown): value is TaskProgress[] =>
  Array.isArray(value) && value.every((item) => isTaskProgress(item));

const renderProgressLine = (entry: TaskProgress, theme: Theme): string => {
  const event = entry.event === null ? theme.muted('progress') : theme.warning(entry.event);
  const firstLine = entry.message.split('\n')[0] ?? '';
  return `${theme.muted(entry.createdAt)}  ${event}  ${firstLine}`;
};

const renderTaskProgress = (value: unknown, context: RenderContext): string => {
  const { theme } = context;
  if (!isTaskProgressArray(value)) return formatJson(value);
  if (value.length === 0) return `${theme.muted('(no progress recorded)')}\n`;
  const visible = value.slice(0, MAX_PROGRESS_ROWS);
  const rows = visible.map((entry) => renderProgressLine(entry, theme));
  if (value.length > MAX_PROGRESS_ROWS) {
    rows.push(
      theme.muted(`(showing ${MAX_PROGRESS_ROWS} of ${value.length} — pass --json for all)`),
    );
  }
  return `${rows.join('\n')}\n`;
};

const renderSingleProgress = (value: unknown, context: RenderContext): string => {
  if (!isTaskProgress(value)) return formatJson(value);
  const { theme } = context;
  return `${theme.success('recorded')}: ${value.message}  ${theme.muted(value.createdAt)}\n`;
};

const isPersistedTaskSession = (value: unknown): value is PersistedTaskSession =>
  typeof value === 'object' &&
  value !== null &&
  'taskId' in value &&
  'provider' in value &&
  'session' in value;

const renderTaskSession = (value: unknown, context: RenderContext): string => {
  if (!isPersistedTaskSession(value)) return formatJson(value);
  const { theme } = context;
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['task', value.taskId],
    ['provider', formatField(theme, value.provider)],
    ['session', formatField(theme, value.session)],
    ['branch', formatField(theme, value.branch)],
    ['plan', formatField(theme, value.plan)],
  ];
  return `${renderKeyValueBlock(rows, theme)}\n`;
};

const isPullRequestStatus = (value: unknown): value is PullRequestStatusReport =>
  typeof value === 'object' &&
  value !== null &&
  'pullRequest' in value &&
  'continuousIntegration' in value &&
  'reviewComments' in value;

const stateColor = (theme: Theme, state: PullRequestStatusReport['pullRequest']['state']) => {
  if (state === 'OPEN') return theme.success;
  if (state === 'MERGED') return theme.heading;
  return theme.muted;
};

const renderPullRequestStatus = (value: unknown, context: RenderContext): string => {
  if (!isPullRequestStatus(value)) return formatJson(value);
  const { theme } = context;
  const pr = value.pullRequest;
  const ci = value.continuousIntegration;
  const ciSummary = `${theme.success(`success ${ci.checks.length - ci.failedCount - ci.pendingCount}`)} • ${theme.warning(`pending ${ci.pendingCount}`)} • ${theme.error(`failed ${ci.failedCount}`)}`;
  const ready = value.readyToMerge ? theme.success('yes') : theme.warning('no');
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['PR', `#${pr.number}  ${pr.title ?? ''}`],
    ['state', stateColor(theme, pr.state)(pr.state)],
    ['branch', `${pr.headRefName} → ${pr.baseRefName}`],
    ['mergeable', formatField(theme, pr.mergeable)],
    ['CI', ciSummary],
    ['unresolved', String(value.reviewComments.unresolvedCount)],
    ['ready to merge', ready],
  ];
  return `${renderKeyValueBlock(rows, theme)}\n`;
};

const isReviewCommentArray = (value: unknown): value is ReviewComment[] =>
  Array.isArray(value) &&
  value.every(
    (item) => typeof item === 'object' && item !== null && 'body' in item && 'isResolved' in item,
  );

const MAX_COMMENT_ROWS = 10;

const renderReviewComment = (
  entry: ReviewComment,
  index: number,
  theme: Theme,
  width: number,
): string => {
  const location =
    entry.path === null ? '' : `  ${entry.path}${entry.line === null ? '' : `:${entry.line}`}`;
  const firstLine = entry.body.split('\n')[0] ?? '';
  const body = truncate(firstLine, Math.max(20, width - 8));
  return `[${index + 1}] ${theme.muted(entry.author ?? 'unknown')}${location}\n      ${body}`;
};

const renderReviewComments = (value: unknown, context: RenderContext): string => {
  const { theme, terminalWidth } = context;
  if (!isReviewCommentArray(value)) return formatJson(value);
  if (value.length === 0) return `${theme.muted('(no review comments)')}\n`;
  const visible = value.slice(0, MAX_COMMENT_ROWS);
  const rows = visible.map((entry, index) =>
    renderReviewComment(entry, index, theme, terminalWidth),
  );
  if (value.length > MAX_COMMENT_ROWS) {
    rows.push(
      theme.muted(`showing ${MAX_COMMENT_ROWS} of ${value.length} — pass --json for full bodies`),
    );
  }
  return `${rows.join('\n')}\n`;
};

const isPullRequestOverviewArray = (value: unknown): value is PullRequestOverviewItem[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'pullRequest' in item &&
      'continuousIntegration' in item &&
      'associatedTasks' in item,
  );

const renderOverviewItem = (item: PullRequestOverviewItem, theme: Theme): string => {
  const pr = item.pullRequest;
  const ci = item.continuousIntegration;
  const ciColor =
    ci.status === 'success' ? theme.success : ci.status === 'pending' ? theme.warning : theme.error;
  const tasksLines =
    item.associatedTasks.length === 0
      ? `  ${theme.muted('tasks:    (none)')}`
      : item.associatedTasks
          .map(
            (task, index) =>
              `  ${index === 0 ? 'tasks:   ' : '         '} ${theme.muted(task.id.slice(0, ID_PREFIX_LENGTH))} ${task.title}`,
          )
          .join('\n');
  const ready = item.readyToMerge ? theme.success('yes') : theme.warning('no');
  return [
    `#${pr.number}  ${pr.title ?? ''}`,
    `  branch:  ${pr.headRefName}`,
    `  CI:      ${ciColor(ci.status)}  (${ci.failedCount} failed, ${ci.pendingCount} pending)`,
    `  review:  ${item.reviewComments.unresolvedCount} unresolved comment(s)`,
    tasksLines,
    `  ready:   ${ready}`,
  ].join('\n');
};

const renderPullRequestOverview = (value: unknown, context: RenderContext): string => {
  const { theme } = context;
  if (!isPullRequestOverviewArray(value)) return formatJson(value);
  if (value.length === 0) return `${theme.muted('(no open pull requests)')}\n`;
  const cards = value.map((item) => renderOverviewItem(item, theme));
  return `${cards.join('\n\n')}\n${theme.muted(`\n${value.length} PR(s)`)}\n`;
};

/**
 * Registry of implemented pretty renderers. The exhaustiveness test enforces
 * lockstep with `renderReadiness`: every `'implemented'` shape must have an
 * entry here; every `'jsonFallback'` shape must not.
 */
export const renderers: Partial<Record<DataShape, PrettyRenderer>> = {
  'task-list': renderTaskList,
  'single-task': renderSingleTask,
  remaining: renderRemaining,
  cleanup: renderCleanup,
  'task-progress': renderTaskProgress,
  'single-task-progress': renderSingleProgress,
  'task-session': renderTaskSession,
  'pr-status': renderPullRequestStatus,
  'review-comments': renderReviewComments,
  'pr-overview': renderPullRequestOverview,
};

/**
 * Dispatches a value to its pretty renderer when one is registered; otherwise
 * silently falls back to JSON. The readiness map plus the exhaustiveness test
 * prevent silent drift — runtime never logs.
 */
export const renderPretty = (shape: DataShape, value: unknown, context: RenderContext): string => {
  const renderer = renderers[shape];
  if (!renderer) return formatJson(value);
  return renderer(value, context);
};

/** Re-exported so callers can branch on readiness without importing both modules. */
export { renderReadiness };

/** Re-exported for callers that need the key/value primitive directly. */
export { renderKeyValueBlock };
