import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from './command-runner.js';
import { SqliteTaskStore } from './database.js';
import { ScrumlordError } from './errors.js';
import { resolveProject } from './project-identity.js';
import { resolveProjectRoot } from './root-resolution.js';
import { runMigrations } from './schema.js';
import type { TaskStore } from './types.js';

export type CreateTaskStoreOptions = {
  cwd?: string;
  now?: () => Date;
  /** Overrides the home directory used to locate `~/.scrumlord`. Tests set this. */
  homeDirectory?: string;
  /** Explicit `--project` selector; defaults to the current repository. */
  projectFlag?: string;
  /** Command runner for git/`gh` resolution; defaults to the real one. */
  runner?: CommandRunner;
};

/**
 * Returns the shared database directory. Defaults to `~/.scrumlord`. An explicit
 * `homeDirectory` argument wins; otherwise the `SCRUMLORD_HOME` environment
 * variable overrides the home directory (used to isolate the shared database in
 * tests and CI without threading an option through every call site).
 */
export const sharedDatabaseDirectory = (homeDirectory?: string): string => {
  const home = homeDirectory ?? process.env['SCRUMLORD_HOME'] ?? homedir();
  return join(home, '.scrumlord');
};

/**
 * Resolves a usable filesystem project root. Unlike the database location, the
 * store still needs a concrete directory for plan paths, worktree derivation,
 * and git operations, so we fall back to `cwd` when neither a git root nor an
 * npm workspace root resolves (e.g. a bare directory). The *project scope* is
 * resolved independently and may still be unknown.
 */
const resolveProjectRootOrCwd = async (cwd: string): Promise<string> => {
  try {
    return await resolveProjectRoot(cwd);
  } catch (error) {
    // A bare directory (no git root, no workspace) is fine — fall back to cwd so
    // the store still has a concrete path; the project scope resolves to UNKNOWN
    // separately. But a genuinely broken workspace manifest is a user error we
    // must surface rather than silently swallow.
    if (error instanceof ScrumlordError && error.code === 'project_root_not_found') {
      return cwd;
    }
    throw error;
  }
};

const openSharedDatabase = (databasePath: string): Database => {
  try {
    const database = new Database(databasePath, { create: true, readwrite: true, strict: true });
    // WAL + a busy timeout let multiple agent sessions across repositories write
    // to the single shared database without spurious SQLITE_BUSY failures. The
    // journal_mode PRAGMA is the first statement to actually touch the file's
    // header, so a non-database file is detected here rather than at migration.
    database.run('PRAGMA journal_mode = WAL;');
    database.run('PRAGMA busy_timeout = 5000;');
    return database;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError(
      'database_open_failed',
      `Could not open task database ${databasePath}: ${message}`,
    );
  }
};

const ensureDatabaseDirectory = (directory: string): void => {
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError(
      'database_directory_failed',
      `Could not create task database directory ${directory}: ${message}`,
    );
  }
};

const migrateOrClose = (database: Database, now: () => Date, projectRoot: string): void => {
  try {
    runMigrations(database, now, { projectRoot });
  } catch (error) {
    database.close(false);
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError('migration_failed', `Could not run task migrations: ${message}`);
  }
};

/** Resolves the project scope, closing the database and re-throwing on failure. */
const resolveScopeOrClose = async (
  database: Database,
  options: CreateTaskStoreOptions,
  cwd: string,
): Promise<{ id: number | null; gitCommonDir: string | null }> => {
  try {
    const resolved = await resolveProject(database, {
      cwd,
      ...(options.projectFlag === undefined ? {} : { projectFlag: options.projectFlag }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    });
    if (resolved.status === 'resolved') {
      return { id: resolved.id, gitCommonDir: resolved.gitCommonDir };
    }
    return { id: null, gitCommonDir: null };
  } catch (error) {
    database.close(false);
    throw error;
  }
};

/**
 * Opens the shared task database at `~/.scrumlord/tasks.db`, runs pending
 * migrations, resolves the project scope for the current command, and returns a
 * project-scoped {@link SqliteTaskStore}. The store's `projectRoot` is always a
 * concrete filesystem path; its project scope may be unresolved, in which case
 * reads return nothing and mutations fail with `project_unresolved`.
 */
export const createTaskStore = async (options: CreateTaskStoreOptions = {}): Promise<TaskStore> => {
  const now = options.now ?? (() => new Date());
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = await resolveProjectRootOrCwd(cwd);

  const databaseDirectory = sharedDatabaseDirectory(options.homeDirectory);
  ensureDatabaseDirectory(databaseDirectory);

  const databasePath = join(databaseDirectory, 'tasks.db');
  const database = openSharedDatabase(databasePath);
  migrateOrClose(database, now, projectRoot);
  const scope = await resolveScopeOrClose(database, options, cwd);

  return new SqliteTaskStore(
    projectRoot,
    databasePath,
    database,
    now,
    scope.id,
    scope.gitCommonDir,
  );
};
