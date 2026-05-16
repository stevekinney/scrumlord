import type { Task } from './types.js';

/** Returns the Markdown fence delimiter for a description, using longest backtick run + 1 (min 3). */
const fenceDelimiter = (text: string): string => {
  let maxRun = 0;
  let currentRun = 0;
  for (const char of text) {
    if (char === '`') {
      currentRun += 1;
      if (currentRun > maxRun) maxRun = currentRun;
    } else {
      currentRun = 0;
    }
  }
  return '`'.repeat(Math.max(3, maxRun + 1));
};

/** Renders the description field for a single-task prompt. */
const renderDescription = (description: string): string => {
  if (!description.trim()) return '_No description provided._';
  const fence = fenceDelimiter(description);
  return `${fence}markdown\n${description}\n${fence}`;
};

/** Returns "none" for an empty tags array, otherwise the comma-separated tag list. */
const tagsDisplay = (tags: string[]): string => (tags.length === 0 ? 'none' : tags.join(', '));

/** Escapes a Markdown table cell value: replaces | with \| and newlines with spaces. */
const escapeTableCell = (value: string): string =>
  value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

/** Renders a GitHub-flavored Markdown table from rows of string arrays. */
const renderTable = (headers: string[], rows: string[][]): string => {
  const escapedHeaders = headers.map(escapeTableCell);
  const separator = escapedHeaders.map(() => '------');
  const escapedRows = rows.map((row) => row.map(escapeTableCell));
  const lines = [
    `| ${escapedHeaders.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...escapedRows.map((row) => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
};

/** Sorts tasks for the batch prompt: priority descending (3 > 2 > 1), then title ascending. */
const sortTasksForBatch = (tasks: Task[]): Task[] =>
  tasks.toSorted((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
  });

/**
 * Renders the Markdown prompt for `tasks plan <task-id>`. Uses projectRoot to emit
 * the absolute deliverable path. Output does not end with a trailing newline.
 */
export const planTaskPrompt = (task: Task, projectRoot: string): string => {
  const tagsValue = tagsDisplay(task.tags);
  const branchValue = task.branch ?? 'none';
  const planValue = task.plan ?? 'none';
  const descriptionBlock = renderDescription(task.description);

  return `# Task Plan Authoring — \`${task.id}\`

You are a senior engineer authoring an implementation plan for one Scrumlord task. Output a single Markdown document and write it to \`tmp/plans/${task.id}.md\` (absolute path: \`${projectRoot}/tmp/plans/${task.id}.md\`). Do not begin implementation.

## Task

- **ID:** \`${task.id}\`
- **Title:** ${task.title}
- **Status:** ${task.status}
- **Priority:** ${task.priority}
- **Tags:** ${tagsValue}
- **Branch:** ${branchValue}
- **Existing plan:** ${planValue}

### Description

${descriptionBlock}

## Deliverable

A single Markdown file at \`tmp/plans/${task.id}.md\` that a different agent could pick up and execute without re-deriving context. The plan must include, in order:

1. **Goal** — one paragraph stating what "done" looks like.
2. **Inventory** — the files, modules, and call sites that will change. Read them first; cite line numbers.
3. **Design** — the data model, types, error semantics, and any new exported functions. Include code blocks for new signatures.
4. **Per-file changes** — a table mapping each touched file to the change.
5. **Tests** — every new test by name, plus the existing tests that need updating.
6. **Risks and rollback** — what breaks if this lands wrong, and how to revert.
7. **Implementation order** — numbered steps, smallest-coherent-commit first.

## Constraints

- Match existing codebase conventions before introducing new patterns. Read \`CLAUDE.md\` first.
- TypeScript only. Kebab-case filenames. No \`any\`, no \`as\` casts.
- No backwards-compatibility shims, no re-export barrels, no migration code.
- Bun is the runtime. Prefer \`Bun.file\`, \`bun:test\`, \`Bun.spawn\` over Node equivalents in scripts and tests; \`src/\` stays runtime-neutral.
- Tests live next to source as \`*.test.ts\`. Coverage threshold is 100% for \`src/\`.
- Do not stub. Do not leave unresolved task markers or placeholder data of any kind.

## Operational steps

1. Read \`CLAUDE.md\`, \`src/cli-arguments.ts\`, \`src/cli-runner.ts\`, \`src/cli-types.ts\`, \`src/help.ts\`, and any file the task description names.
2. Run \`tasks get ${task.id}\` to confirm the task record matches the prompt context.
3. Run \`tasks blocked-by ${task.id}\` to surface dependencies that must land first.
4. Draft the plan to \`tmp/plans/${task.id}.md\`.
5. When you finish, if the \`plan-review\` skill is available in your environment, invoke it against the plan and iterate until approval or the 20-round cap. If \`plan-review\` is not available, run an adversarial review pass yourself (act as a hostile senior reviewer against your own plan; list concerns; address or rebut each) and document any unresolved concerns at the bottom of the plan under a \`## Unresolved review concerns\` heading.

## Quality bar

A reviewer should be able to read the plan top-to-bottom and answer: what files change, what new types exist, what every new test asserts, and what the rollback step is. If any of those answers require guessing, the plan is not done.`;
};

/**
 * Renders the Markdown prompt for `tasks plan` (batch). Uses projectRoot to emit
 * the absolute output-directory path. Empty array yields the empty-batch variant.
 * Output does not end with a trailing newline.
 */
export const planBatchPrompt = (tasks: Task[], projectRoot: string): string => {
  if (tasks.length === 0) {
    return `# Task Plan Authoring — Batch

There are no available, unplanned tasks. No action required.`;
  }

  const sorted = sortTasksForBatch(tasks);
  const table = renderTable(
    ['ID', 'Title', 'Priority', 'Tags'],
    sorted.map((t) => [t.id, t.title, String(t.priority), tagsDisplay(t.tags)]),
  );

  return `# Task Plan Authoring — Batch

You are a senior engineer authoring implementation plans for every available Scrumlord task that does not yet have one. There are ${tasks.length} such tasks. Output one Markdown file per task and write each to \`tmp/plans/<task-id>.md\` (absolute path: \`${projectRoot}/tmp/plans/<task-id>.md\`). Do not begin implementation on any of them.

## Tasks to plan

${table}

## Deliverable

For each task above, produce \`tmp/plans/<task-id>.md\` matching this outline:

1. **Goal** — one paragraph stating what "done" looks like.
2. **Inventory** — files and call sites that will change, with line-number citations.
3. **Design** — types, signatures, error semantics, new exports.
4. **Per-file changes** — table mapping each touched file to the change.
5. **Tests** — every new test by name, plus existing tests that need updating.
6. **Risks and rollback** — what breaks, and how to revert.
7. **Implementation order** — numbered steps.

## Constraints

- Match existing codebase conventions. Read \`CLAUDE.md\` first.
- TypeScript only, kebab-case filenames, no \`any\`, no \`as\` casts.
- No backwards-compatibility shims or migration code.
- Bun is the runtime. Prefer Bun primitives in scripts and tests; keep \`src/\` runtime-neutral.
- Tests colocate as \`*.test.ts\`; coverage threshold is 100% for \`src/\`.

## Operational steps

For each task in the table:

1. Run \`tasks get <id>\` to read the full record (description, blockers, branch, tags).
2. Run \`tasks blocked-by <id>\` to record blockers; order the plan steps accordingly. Do not change task state, run blocker work, or modify the dependency graph — planning only.
3. Read every file the task description references.
4. Draft \`tmp/plans/<id>.md\`.
5. If the \`plan-review\` skill is available, invoke it on each plan and iterate until approval or the 20-round cap. Otherwise run an adversarial self-review pass per plan and document unresolved concerns.

Tasks in the table above are already pre-sorted by the command (highest priority first; ties broken by title sort). Process them in the order presented. Parallelize plan drafting across tasks when no dependency relationship exists between them.

## Quality bar

Each plan must answer, without ambiguity: which files change, which types and signatures are new, what every new test asserts, and what the rollback step is. Skip the plan only if the task is fundamentally underspecified — in that case write a one-paragraph stub at \`tmp/plans/<id>.md\` explaining what information is missing and stop.`;
};
