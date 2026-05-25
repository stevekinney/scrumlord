import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ParsedArguments } from './cli-arguments.js';
import type { CliOptions } from './cli-types.js';
import type { CommandRunner } from './command-runner.js';
import { runCommand as defaultRunner } from './command-runner.js';
import { sharedDatabaseDirectory } from './database-open.js';
import { ScrumlordError } from './errors.js';
import { requireProjectId } from './project-identity.js';
import { runMigrations } from './schema.js';

type QueryBindings = Record<string, string | number | null>;

/** Per-table import tallies for one source database. */
export type SourceImportSummary = {
  source: string;
  nameWithOwner: string;
  tasks: { imported: number; skipped: number };
  tags: { imported: number; skipped: number };
  dependencies: { imported: number; skipped: number };
  progress: { imported: number; skipped: number };
};

export type ImportLegacyDatabasesResult = {
  dryRun: boolean;
  backupPath: string | null;
  sources: SourceImportSummary[];
};

export type ImportLegacyDatabasesOptions = {
  /** Source repository roots whose `tmp/tasks.db` will be imported. */
  from: string[];
  dryRun: boolean;
  homeDirectory?: string;
  now?: () => Date;
  runner?: CommandRunner;
};

/** The three repositories ported when `--from` is omitted (printed for confirmation). */
export const defaultLegacySources = (homeDirectory = homedir()): string[] => [
  join(homeDirectory, 'Developer', 'weft'),
  join(homeDirectory, 'Developer', 'cinder'),
  join(homeDirectory, 'Developer', 'scrumlord'),
];

type LegacyTaskRow = {
  id: string;
  title: string;
  status: string;
  description: string;
  priority: number;
  created_at: string;
  start_date: string | null;
  due_date: string | null;
  last_modified_at: string;
  deleted: number;
  branch: string | null;
  plan: string | null;
  provider: string | null;
  session: string | null;
};

type TagRow = { task_id: string; tag: string };
type DependencyRow = { task_id: string; blocked_by_task_id: string };
type ProgressRow = {
  id: string;
  task_id: string;
  message: string;
  created_at: string;
  provider: string | null;
  session: string | null;
  event: string | null;
  tool: string | null;
  cwd: string | null;
  transcript_path: string | null;
  commit_sha: string | null;
};

const emptyTally = () => ({ imported: 0, skipped: 0 });

const sameRow = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  return true;
};

/** Imports the `tasks` rows, stamping the project id. Aborts on a divergent same-id task. */
const importTasks = (
  shared: Database,
  source: Database,
  projectId: number,
  dryRun: boolean,
): SourceImportSummary['tasks'] => {
  const tally = emptyTally();
  const rows = source.query<LegacyTaskRow, []>('SELECT * FROM tasks').all();
  for (const row of rows) {
    const existing = shared
      .query<
        { project_id: number } & LegacyTaskRow,
        QueryBindings
      >('SELECT * FROM tasks WHERE id = $id')
      .get({ id: row.id });
    if (existing) {
      const { project_id: existingProject, ...existingTask } = existing;
      if (existingProject === projectId && sameRow(existingTask, row)) {
        tally.skipped += 1;
        continue;
      }
      throw new ScrumlordError(
        'import_collision',
        `Task id ${row.id} already exists in the shared database with different content; ` +
          `aborting import of this source.`,
      );
    }
    if (!dryRun) {
      shared
        .query<unknown, QueryBindings>(
          `INSERT INTO tasks (
             id, title, status, description, priority, created_at, start_date, due_date,
             last_modified_at, deleted, branch, plan, provider, session, project_id
           ) VALUES (
             $id, $title, $status, $description, $priority, $created_at, $start_date, $due_date,
             $last_modified_at, $deleted, $branch, $plan, $provider, $session, $projectId
           )`,
        )
        .run({ ...row, projectId });
    }
    tally.imported += 1;
  }
  return tally;
};

/**
 * Whether a child row's parent task belongs to the project being imported. The
 * parent is owned when it is already in the shared project, or — during a dry
 * run, where parent tasks were counted but not written — when it exists in the
 * source's own `tasks` table (a real run would have imported it).
 */
const parentTaskOwned = (
  shared: Database,
  source: Database,
  projectId: number,
  dryRun: boolean,
  taskId: string,
): boolean => {
  const inProject = shared
    .query<
      { one: number },
      QueryBindings
    >('SELECT 1 AS one FROM tasks WHERE id = $id AND project_id = $projectId')
    .get({ id: taskId, projectId });
  if (inProject) return true;
  if (!dryRun) return false;
  return Boolean(
    source.query<{ one: number }, QueryBindings>('SELECT 1 AS one FROM tasks WHERE id = $id').get({
      id: taskId,
    }),
  );
};

const importTags = (
  shared: Database,
  source: Database,
  projectId: number,
  dryRun: boolean,
): SourceImportSummary['tags'] => {
  const tally = emptyTally();
  const rows = source.query<TagRow, []>('SELECT task_id, tag FROM task_tags').all();
  for (const row of rows) {
    // task_tags rows are value-only; only insert when the parent task belongs to
    // this project and the (task_id, tag) pair is not already present.
    if (!parentTaskOwned(shared, source, projectId, dryRun, row.task_id)) {
      tally.skipped += 1;
      continue;
    }
    const present = shared
      .query<
        { one: number },
        QueryBindings
      >('SELECT 1 AS one FROM task_tags WHERE task_id = $id AND tag = $tag')
      .get({ id: row.task_id, tag: row.tag });
    if (present) {
      tally.skipped += 1;
      continue;
    }
    if (!dryRun) {
      shared
        .query<
          unknown,
          QueryBindings
        >('INSERT INTO task_tags (task_id, tag) VALUES ($task_id, $tag)')
        .run({ task_id: row.task_id, tag: row.tag });
    }
    tally.imported += 1;
  }
  return tally;
};

const importDependencies = (
  shared: Database,
  source: Database,
  projectId: number,
  dryRun: boolean,
): SourceImportSummary['dependencies'] => {
  const tally = emptyTally();
  const rows = source
    .query<DependencyRow, []>('SELECT task_id, blocked_by_task_id FROM task_dependencies')
    .all();
  // An endpoint is valid if it is already imported into this project, or — in a
  // dry run, where tasks were counted but not written — if it exists in the
  // source's own `tasks` table (it would have been imported in a real run).
  const inSource = (id: string): boolean =>
    Boolean(
      source
        .query<{ one: number }, QueryBindings>('SELECT 1 AS one FROM tasks WHERE id = $id')
        .get({ id }),
    );
  const inProject = (id: string): boolean =>
    Boolean(
      shared
        .query<
          { one: number },
          QueryBindings
        >('SELECT 1 AS one FROM tasks WHERE id = $id AND project_id = $projectId')
        .get({ id, projectId }),
    ) || inSource(id);
  for (const row of rows) {
    if (!inProject(row.task_id) || !inProject(row.blocked_by_task_id)) {
      throw new ScrumlordError(
        'import_collision',
        `Dependency edge ${row.task_id} -> ${row.blocked_by_task_id} references a task missing ` +
          `from this project; aborting import of this source.`,
      );
    }
    const present = shared
      .query<
        { one: number },
        QueryBindings
      >('SELECT 1 AS one FROM task_dependencies WHERE task_id = $task AND blocked_by_task_id = $blocker')
      .get({ task: row.task_id, blocker: row.blocked_by_task_id });
    if (present) {
      tally.skipped += 1;
      continue;
    }
    if (!dryRun) {
      shared
        .query<
          unknown,
          QueryBindings
        >('INSERT INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($task, $blocker)')
        .run({ task: row.task_id, blocker: row.blocked_by_task_id });
    }
    tally.imported += 1;
  }
  return tally;
};

/**
 * Finds the shared-database progress row that is the natural-key match for a
 * source row: `(task_id, commit_sha)` when a commit SHA is present (the unique
 * index), otherwise `(task_id, created_at, message)`.
 */
const matchingProgress = (shared: Database, row: ProgressRow): ProgressRow | null => {
  if (row.commit_sha !== null) {
    return shared
      .query<
        ProgressRow,
        QueryBindings
      >('SELECT * FROM task_progress WHERE task_id = $task AND commit_sha = $sha')
      .get({ task: row.task_id, sha: row.commit_sha });
  }
  return shared
    .query<ProgressRow, QueryBindings>(
      `SELECT * FROM task_progress
       WHERE task_id = $task AND created_at = $createdAt AND message = $message`,
    )
    .get({ task: row.task_id, createdAt: row.created_at, message: row.message });
};

const importProgress = (
  shared: Database,
  source: Database,
  projectId: number,
  dryRun: boolean,
): SourceImportSummary['progress'] => {
  const tally = emptyTally();
  const rows = source.query<ProgressRow, []>('SELECT * FROM task_progress').all();
  for (const row of rows) {
    if (!parentTaskOwned(shared, source, projectId, dryRun, row.task_id)) {
      tally.skipped += 1;
      continue;
    }
    const existing = matchingProgress(shared, row);
    if (existing) {
      if (sameRow({ ...existing }, { ...row, id: existing.id })) {
        tally.skipped += 1;
        continue;
      }
      throw new ScrumlordError(
        'import_collision',
        `Progress for task ${row.task_id} diverges from an existing row; aborting import.`,
      );
    }
    // The progress id is a global UUID today, but preserve it only when free —
    // otherwise mint a new one so two sources reusing an id never collide.
    const idTaken = shared
      .query<{ one: number }, QueryBindings>('SELECT 1 AS one FROM task_progress WHERE id = $id')
      .get({ id: row.id });
    const id = idTaken ? crypto.randomUUID() : row.id;
    if (!dryRun) {
      shared
        .query<unknown, QueryBindings>(
          `INSERT INTO task_progress (
             id, task_id, message, created_at, provider, session,
             event, tool, cwd, transcript_path, commit_sha
           ) VALUES (
             $id, $task_id, $message, $created_at, $provider, $session,
             $event, $tool, $cwd, $transcript_path, $commit_sha
           )`,
        )
        .run({ ...row, id });
    }
    tally.imported += 1;
  }
  return tally;
};

const importSource = (
  shared: Database,
  sourceRoot: string,
  projectId: number,
  nameWithOwner: string,
  dryRun: boolean,
): SourceImportSummary => {
  const sourceDbPath = join(sourceRoot, 'tmp', 'tasks.db');
  const source = new Database(sourceDbPath, { readonly: true, strict: true });
  try {
    let summary: SourceImportSummary;
    const transaction = shared.transaction(() => {
      summary = {
        source: sourceRoot,
        nameWithOwner,
        tasks: importTasks(shared, source, projectId, dryRun),
        tags: importTags(shared, source, projectId, dryRun),
        dependencies: importDependencies(shared, source, projectId, dryRun),
        progress: importProgress(shared, source, projectId, dryRun),
      };
    });
    transaction.immediate();
    return summary!;
  } finally {
    source.close(false);
  }
};

/**
 * Ports the per-repository legacy `tmp/tasks.db` databases into the shared
 * `~/.scrumlord/tasks.db`, stamping each task with its resolved project. The
 * shared database is snapshotted with `VACUUM INTO` before any write so a bad
 * import can be rolled back. The operation is idempotent: re-running skips rows
 * that already match, and aborts a source's transaction (leaving it unchanged)
 * if any row diverges from what is already stored.
 */
export const importLegacyDatabases = async (
  options: ImportLegacyDatabasesOptions,
): Promise<ImportLegacyDatabasesResult> => {
  const runner = options.runner ?? defaultRunner;
  const now = options.now ?? (() => new Date());
  const directory = sharedDatabaseDirectory(options.homeDirectory);
  mkdirSync(directory, { recursive: true });
  const sharedPath = join(directory, 'tasks.db');

  const shared = new Database(sharedPath, { create: true, readwrite: true, strict: true });
  shared.run('PRAGMA journal_mode = WAL;');
  shared.run('PRAGMA busy_timeout = 5000;');
  try {
    runMigrations(shared, now, { projectRoot: directory });

    let backupPath: string | null = null;
    if (!options.dryRun) {
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      backupPath = join(directory, `tasks.db.bak-${stamp}`);
      // VACUUM INTO is a consistent online snapshot, safe under WAL even with
      // other writers — unlike copying the .db/-wal/-shm files.
      shared.query('VACUUM INTO $path').run({ path: backupPath });
    }

    const sources: SourceImportSummary[] = [];
    for (const sourceRoot of options.from) {
      const sourceDbPath = join(sourceRoot, 'tmp', 'tasks.db');
      if (!existsSync(sourceDbPath)) {
        throw new ScrumlordError('import_source_missing', `No legacy database at ${sourceDbPath}.`);
      }
      const projectId = await requireProjectId(shared, { cwd: sourceRoot, runner });
      const nameWithOwner = shared
        .query<
          { name_with_owner: string },
          QueryBindings
        >('SELECT name_with_owner FROM projects WHERE id = $id')
        .get({ id: projectId })!.name_with_owner;
      sources.push(importSource(shared, sourceRoot, projectId, nameWithOwner, options.dryRun));
    }

    return { dryRun: options.dryRun, backupPath, sources };
  } finally {
    shared.close(false);
  }
};

/**
 * CLI adapter for the `import-legacy-databases` boundary command. Resolves
 * sources from `--from` (repeatable) or, when omitted, the printed defaults —
 * which require `--confirm` so the operator never silently imports repositories
 * they did not intend.
 */
export const runImportLegacyDatabases = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<ImportLegacyDatabasesResult> => {
  const dryRun = parsed.flags.has('dry-run');
  const explicitSources = parsed.flags.get('from') ?? [];
  let from = explicitSources;
  if (from.length === 0) {
    from = defaultLegacySources(options.homeDirectory);
    if (!parsed.flags.has('confirm')) {
      throw new ScrumlordError(
        'import_sources_unconfirmed',
        `No --from given. Pass --confirm to import the defaults, or list sources with --from:\n` +
          from.map((path) => `  ${path}`).join('\n'),
      );
    }
  }
  return importLegacyDatabases({
    from,
    dryRun,
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
};
