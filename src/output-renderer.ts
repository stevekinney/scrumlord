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
  command?: string;
  countLabel?: string;
};

/** Construction helper. Keeps boundary defaults (width 100) in one place. */
export const createRenderContext = (input: {
  colorMode: ColorMode;
  terminalWidth?: number;
  flags: ReadonlySet<string>;
  command?: string;
  countLabel?: string;
}): RenderContext => ({
  theme: createTheme(input.colorMode),
  colorMode: input.colorMode,
  terminalWidth: input.terminalWidth ?? 100,
  flags: input.flags,
  ...(input.command !== undefined ? { command: input.command } : {}),
  ...(input.countLabel !== undefined ? { countLabel: input.countLabel } : {}),
});

type PrettyRenderer = (value: unknown, context: RenderContext) => string;

const isTask = (value: unknown): value is Task =>
  typeof value === 'object' && value !== null && 'id' in value && 'title' in value;

const isTaskArray = (value: unknown): value is Task[] =>
  Array.isArray(value) && value.every((item) => isTask(item));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

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

const ansiEscapeSequenceEnd = (value: string, index: number): number | null => {
  if (value.charCodeAt(index) !== 27 || value[index + 1] !== '[') return null;
  for (let cursor = index + 2; cursor < value.length; cursor += 1) {
    const code = value.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) return cursor + 1;
  }
  return null;
};

const visibleLength = (value: string): number => {
  let width = 0;
  for (let index = 0; index < value.length; ) {
    const escapeEnd = ansiEscapeSequenceEnd(value, index);
    if (escapeEnd !== null) {
      index = escapeEnd;
      continue;
    }
    const [character] = Array.from(value.slice(index));
    if (!character) break;
    width += 1;
    index += character.length;
  }
  return width;
};

const truncateVisible = (value: string, width: number): string => {
  if (visibleLength(value) <= width) return value;
  if (width <= 0) return '';

  let visible = 0;
  let output = '';
  const target = Math.max(0, width - 1);
  for (let index = 0; index < value.length && visible < target; ) {
    const escapeEnd = ansiEscapeSequenceEnd(value, index);
    if (escapeEnd !== null) {
      output += value.slice(index, escapeEnd);
      index = escapeEnd;
      continue;
    }
    const [character] = Array.from(value.slice(index));
    if (!character) break;
    output += character;
    visible += 1;
    index += character.length;
  }

  return output.includes('\u001B[') ? `${output}…\u001B[0m` : `${output}…`;
};

const padEnd = (value: string, width: number): string =>
  value + ' '.repeat(Math.max(0, width - value.length));

const padEndVisible = (value: string, width: number): string =>
  value + ' '.repeat(Math.max(0, width - visibleLength(value)));

const STATUS_WIDTH = Math.max(
  ...['draft', 'ready', 'in-progress', 'in-review', 'completed'].map((s) => s.length),
);
const MAX_LIST_ROWS = 50;
const ID_PREFIX_LENGTH = 8;

const renderTaskRow = (
  task: Task,
  theme: Theme,
  titleWidth: number,
  terminalWidth: number,
): string => {
  const id = theme.muted(task.id.slice(0, ID_PREFIX_LENGTH));
  const status = statusColor(theme, task.status)(padEnd(task.status, STATUS_WIDTH));
  const priority = priorityColor(theme, task.priority)(`P${task.priority}`);
  const title = truncate(task.title, titleWidth);
  const tags = task.tags.length > 0 ? `  ${theme.muted(task.tags.join(','))}` : '';
  return truncateVisible(`${id}  ${status}  ${priority}  ${title}${tags}`, terminalWidth);
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
  const rows = visible.map((task) => renderTaskRow(task, theme, titleWidth, terminalWidth));

  if (value.length > MAX_LIST_ROWS) {
    rows.push('');
    rows.push(
      truncateVisible(
        theme.muted(`showing ${MAX_LIST_ROWS} of ${value.length} — pass --json for the full list`),
        terminalWidth,
      ),
    );
    return `${rows.join('\n')}\n`;
  }

  const label = countLabel ?? 'task(s)';
  rows.push('');
  rows.push(truncateVisible(theme.muted(`${value.length} ${label}`), terminalWidth));
  return `${rows.join('\n')}\n`;
};

type YamlScalar = string | number | boolean | null;
type YamlBlocker = { readonly id: string; readonly status: string };
type YamlValue = YamlScalar | readonly string[] | readonly YamlBlocker[];

const formatField = (theme: Theme, value: string | null, fallback = '(none)'): string =>
  value === null || value === '' ? theme.muted(fallback) : value;

const renderKeyValueBlock = (
  entries: ReadonlyArray<readonly [string, string]>,
  theme: Theme,
): string => {
  const keyWidth = Math.max(...entries.map(([key]) => key.length));
  return entries
    .map(([key, value]) => `${theme.muted(key.padStart(keyWidth))}  ${value}`)
    .join('\n');
};

const renderYamlScalar = (value: YamlScalar): string => {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

const isYamlArray = (value: YamlValue): value is readonly string[] | readonly YamlBlocker[] =>
  Array.isArray(value);

const isBlockerArray = (
  value: readonly string[] | readonly YamlBlocker[],
): value is readonly YamlBlocker[] => value.length > 0 && typeof value[0] === 'object';

const renderYamlBlocker = (blocker: YamlBlocker): string =>
  `{ id: ${renderYamlScalar(blocker.id)}, status: ${renderYamlScalar(blocker.status)} }`;

const renderYamlField = (key: string, value: YamlValue): string => {
  if (!isYamlArray(value)) return `${key}: ${renderYamlScalar(value)}`;
  if (value.length === 0) return `${key}: []`;
  if (isBlockerArray(value)) {
    return [`${key}:`, ...value.map((item) => `  - ${renderYamlBlocker(item)}`)].join('\n');
  }
  return [`${key}:`, ...value.map((item) => `  - ${renderYamlScalar(item)}`)].join('\n');
};

const taskFrontMatterFields = (task: Task): ReadonlyArray<readonly [string, YamlValue]> => [
  ['id', task.id],
  ['title', task.title],
  ['status', task.status],
  ['priority', task.priority],
  ['createdAt', task.createdAt],
  ['startDate', task.startDate],
  ['dueDate', task.dueDate],
  ['branch', task.branch],
  ['plan', task.plan],
  ['provider', task.provider],
  ['session', task.session],
  ['tags', task.tags],
  ['blocked', task.blocked],
  ['blockedBy', task.blockedBy],
  ['blocking', task.blocking],
  ['lastModifiedAt', task.lastModifiedAt],
  ['deleted', task.deleted],
];

const renderTaskMarkdownDocument = (task: Task): string => {
  const frontMatter = taskFrontMatterFields(task)
    .map(([key, value]) => renderYamlField(key, value))
    .join('\n');
  return `---\n${frontMatter}\n---\n\n${task.description}\n`;
};

const renderSingleTask = (value: unknown, context: RenderContext): string => {
  const { theme } = context;
  if (value === null) return `${theme.muted('(no task)')}\n`;
  if (!isTask(value)) return formatJson(value);
  return renderTaskMarkdownDocument(value);
};

const renderTagList = (value: unknown, context: RenderContext): string => {
  const { theme } = context;
  if (!isStringArray(value)) return formatJson(value);
  if (value.length === 0) return `${theme.muted('(no tags)')}\n`;
  return `${value.map((tag) => `- ${tag}`).join('\n')}\n`;
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
  const isFull = context.flags.has('full');
  const visible = isFull ? value : value.slice(-MAX_PROGRESS_ROWS);
  const rows = visible.map((entry) => renderProgressLine(entry, theme));
  if (!isFull && value.length > MAX_PROGRESS_ROWS) {
    rows.push(
      theme.muted(
        `(showing most recent ${MAX_PROGRESS_ROWS} of ${value.length} — pass --full for all)`,
      ),
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

type OverviewColumn = {
  header: string;
  cells: string[];
};

const overviewTaskCell = (item: PullRequestOverviewItem, theme: Theme): string => {
  const [task] = item.associatedTasks;
  if (!task) return theme.muted('-');
  const suffix = item.associatedTasks.length > 1 ? ` +${item.associatedTasks.length - 1}` : '';
  return `${theme.muted(task.id.slice(0, ID_PREFIX_LENGTH))} ${task.title}${suffix}`;
};

const overviewCiCell = (item: PullRequestOverviewItem, theme: Theme): string => {
  const ci = item.continuousIntegration;
  if (ci.status === 'success') return theme.success('ok');
  if (ci.status === 'pending') return theme.warning(`wait ${ci.pendingCount}`);
  return theme.error(`fail ${ci.failedCount}`);
};

const hasMergeConflicts = (item: PullRequestOverviewItem): boolean | null => {
  const { mergeable, mergeStateStatus } = item.pullRequest;
  if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') return true;
  if (mergeable === null && mergeStateStatus === null) return null;
  if (mergeable === 'UNKNOWN' || mergeStateStatus === 'UNKNOWN') return null;
  return false;
};

const overviewMergeConflictsCell = (item: PullRequestOverviewItem, theme: Theme): string => {
  const conflicts = hasMergeConflicts(item);
  if (conflicts === null) return theme.muted('?');
  return conflicts ? theme.error('yes') : theme.success('no');
};

const overviewColumns = (value: PullRequestOverviewItem[], theme: Theme): OverviewColumn[] => [
  {
    header: 'PR',
    cells: value.map((item) => `#${item.pullRequest.number}`),
  },
  {
    header: 'Branch',
    cells: value.map((item) => item.pullRequest.headRefName),
  },
  {
    header: 'Task',
    cells: value.map((item) => overviewTaskCell(item, theme)),
  },
  {
    header: 'Rd',
    cells: value.map((item) => (item.readyToMerge ? theme.success('✔') : theme.warning('X'))),
  },
  {
    header: 'Cmt',
    cells: value.map((item) => String(item.reviewComments.unresolvedCount)),
  },
  {
    header: 'CI',
    cells: value.map((item) => overviewCiCell(item, theme)),
  },
  {
    header: 'Conf',
    cells: value.map((item) => overviewMergeConflictsCell(item, theme)),
  },
];

const desiredColumnWidth = (column: OverviewColumn): number => {
  return Math.max(visibleLength(column.header), ...column.cells.map((cell) => visibleLength(cell)));
};

const overviewColumnWidths = (columns: OverviewColumn[], terminalWidth: number): number[] => {
  const separatorWidth = 2;
  const available = Math.max(0, terminalWidth - separatorWidth * (columns.length - 1));
  const widths = columns.map(desiredColumnWidth);
  while (widths.reduce((sum, width) => sum + width, 0) > available) {
    let widestIndex = 0;
    for (let index = 1; index < widths.length; index += 1) {
      if ((widths[index] ?? 0) > (widths[widestIndex] ?? 0)) widestIndex = index;
    }
    if (widths[widestIndex] === 0) break;
    widths[widestIndex] = (widths[widestIndex] ?? 0) - 1;
  }
  return widths;
};

const renderOverviewTableRow = (cells: string[], widths: number[]): string => {
  return truncateVisible(
    cells
      .map((cell, index) =>
        padEndVisible(truncateVisible(cell, widths[index] ?? 0), widths[index] ?? 0),
      )
      .join('  '),
    widths.reduce((sum, width) => sum + width, 0) + 2 * Math.max(0, widths.length - 1),
  );
};

const renderPullRequestOverview = (value: unknown, context: RenderContext): string => {
  const { theme, terminalWidth } = context;
  if (!isPullRequestOverviewArray(value)) return formatJson(value);
  if (value.length === 0) return `${theme.muted('(No open pull requests.)')}\n`;
  const columns = overviewColumns(value, theme);
  const widths = overviewColumnWidths(columns, terminalWidth);
  const header = renderOverviewTableRow(
    columns.map((column) => theme.bold(column.header)),
    widths,
  );
  const dividerWidth = Math.min(
    terminalWidth,
    widths.reduce((sum, width) => sum + width, 0) + 2 * Math.max(0, widths.length - 1),
  );
  const rows = value.map((_, rowIndex) =>
    renderOverviewTableRow(
      columns.map((column) => column.cells[rowIndex] ?? ''),
      widths,
    ),
  );
  rows.push('');
  rows.push(truncateVisible(theme.muted(`${value.length} PR(s)`), terminalWidth));
  return `${[header, '-'.repeat(dividerWidth), ...rows].join('\n')}\n`;
};

/**
 * Registry of implemented pretty renderers. The exhaustiveness test enforces
 * lockstep with `renderReadiness`: every `'implemented'` shape must have an
 * entry here; every `'jsonFallback'` shape must not.
 */
export const renderers: Partial<Record<DataShape, PrettyRenderer>> = {
  'task-list': renderTaskList,
  'single-task': renderSingleTask,
  'tag-list': renderTagList,
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
