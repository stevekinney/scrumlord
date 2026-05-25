import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { ScrumlordError } from './errors.js';

type QueryBindings = Record<string, string | number | null>;

/**
 * Context passed to migrations whose `run` callback needs more than the
 * database handle. Currently includes the wall-clock `now`, the project root
 * (required by v6 to resolve relative plan paths), a `recordMigration` helper
 * that inserts this migration's row into `task_migrations`, and a `warn`
 * callback for non-fatal advisory output (the runner pipes it to stderr).
 */
type MigrationRunContext = {
  database: Database;
  now: () => Date;
  projectRoot: string;
  recordMigration: () => void;
  warn: (message: string) => void;
};

type StandardMigration = {
  version: number;
  name: string;
  sql: string;
  requiresOwnTransaction?: false;
  run?: never;
};

type OwnTransactionMigration = {
  version: number;
  name: string;
  sql?: never;
  requiresOwnTransaction: true;
  run: (context: MigrationRunContext) => void;
};

type Migration = StandardMigration | OwnTransactionMigration;

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'create_task_graph',
    sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'in-progress', 'in-review', 'completed')),
        description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL CHECK (priority IN (1, 2, 3)),
        created_at TEXT NOT NULL,
        start_date TEXT,
        due_date TEXT,
        last_modified_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        CHECK (parent_id IS NULL OR parent_id != id)
      );

      CREATE TABLE task_tags (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag TEXT NOT NULL CHECK (length(trim(tag)) > 0),
        PRIMARY KEY (task_id, tag)
      );

      CREATE TABLE task_dependencies (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        blocked_by_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, blocked_by_task_id),
        CHECK (task_id != blocked_by_task_id)
      );

      CREATE INDEX task_tags_tag_index ON task_tags(tag);
      CREATE INDEX task_dependencies_blocked_by_index ON task_dependencies(blocked_by_task_id);
      CREATE INDEX tasks_status_priority_index ON tasks(status, priority);
    `,
  },
  {
    version: 2,
    name: 'add_task_branch',
    sql: `
      ALTER TABLE tasks ADD COLUMN branch TEXT;
      CREATE INDEX tasks_branch_index ON tasks(branch);
    `,
  },
  {
    version: 3,
    name: 'add_task_agent_session_fields',
    sql: `
      ALTER TABLE tasks ADD COLUMN plan TEXT;
      ALTER TABLE tasks ADD COLUMN provider TEXT CHECK (provider IS NULL OR provider IN ('claude', 'codex'));
      ALTER TABLE tasks ADD COLUMN session TEXT;
      CREATE INDEX tasks_provider_session_index ON tasks(provider, session);
    `,
  },
  {
    version: 4,
    name: 'add_task_progress',
    sql: `
      CREATE TABLE task_progress (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message TEXT NOT NULL CHECK (length(trim(message)) > 0),
        created_at TEXT NOT NULL,
        provider TEXT CHECK (provider IS NULL OR provider IN ('claude', 'codex')),
        session TEXT
      );

      CREATE INDEX task_progress_task_created_index ON task_progress(task_id, created_at, id);
    `,
  },
  {
    version: 5,
    name: 'drop_archived_and_parent',
    requiresOwnTransaction: true,
    run: runDropArchivedAndParent,
  },
  {
    version: 6,
    name: 'normalize_plan_paths',
    requiresOwnTransaction: true,
    run: runNormalizePlanPaths,
  },
  {
    version: 7,
    name: 'add_progress_event_metadata',
    sql: `
      ALTER TABLE task_progress ADD COLUMN event TEXT
        CHECK (event IS NULL OR event IN ('session_start', 'session_stop', 'session_end', 'tool_failed', 'commit'));
      ALTER TABLE task_progress ADD COLUMN tool TEXT;
      ALTER TABLE task_progress ADD COLUMN cwd TEXT;
      ALTER TABLE task_progress ADD COLUMN transcript_path TEXT;
      ALTER TABLE task_progress ADD COLUMN commit_sha TEXT;

      CREATE UNIQUE INDEX task_progress_commit_sha_unique
        ON task_progress(task_id, commit_sha) WHERE commit_sha IS NOT NULL;

      CREATE TRIGGER task_progress_event_metadata_insert
        BEFORE INSERT ON task_progress
        FOR EACH ROW
        WHEN (NEW.commit_sha IS NOT NULL AND NEW.event IS NOT 'commit')
          OR (NEW.tool IS NOT NULL AND NEW.event IS NOT 'tool_failed')
          OR (NEW.transcript_path IS NOT NULL AND NEW.event IS NOT 'session_start')
        BEGIN
          SELECT RAISE(ABORT, 'task_progress_event_metadata_mismatch');
        END;

      CREATE TRIGGER task_progress_event_metadata_update
        BEFORE UPDATE ON task_progress
        FOR EACH ROW
        WHEN (NEW.commit_sha IS NOT NULL AND NEW.event IS NOT 'commit')
          OR (NEW.tool IS NOT NULL AND NEW.event IS NOT 'tool_failed')
          OR (NEW.transcript_path IS NOT NULL AND NEW.event IS NOT 'session_start')
        BEGIN
          SELECT RAISE(ABORT, 'task_progress_event_metadata_mismatch');
        END;
    `,
  },
  {
    version: 8,
    name: 'add_projects_and_project_scope',
    requiresOwnTransaction: true,
    run: runAddProjectsAndProjectScope,
  },
];

/**
 * Rewrites stored plan values to absolute filesystem paths (resolving any
 * relative paths against `projectRoot`). Existing absolute paths are
 * normalised. Tasks whose plan file does not exist at the resolved path are
 * left untouched (the absolute path is still written) and surfaced via
 * `warn()` so the operator can investigate; the migration never throws on
 * missing files because pre-existing data may have drifted.
 */
function normalizePlanRow(
  database: Database,
  projectRoot: string,
  row: { id: string; plan: string | null },
): { id: string; path: string } | null {
  if (!row.plan) return null;
  const absolute = isAbsolute(row.plan) ? normalize(row.plan) : resolve(projectRoot, row.plan);
  if (absolute !== row.plan) {
    database
      .query<unknown, QueryBindings>('UPDATE tasks SET plan = $plan WHERE id = $id')
      .run({ plan: absolute, id: row.id });
  }
  return existsSync(absolute) ? null : { id: row.id, path: absolute };
}

function runNormalizePlanPaths(context: MigrationRunContext): void {
  const { database, projectRoot, recordMigration, warn } = context;
  let inTransaction = false;
  try {
    database.run('BEGIN');
    inTransaction = true;
    const rows = database
      .query<
        { id: string; plan: string | null },
        []
      >('SELECT id, plan FROM tasks WHERE plan IS NOT NULL')
      .all();
    const missing: { id: string; path: string }[] = [];
    for (const row of rows) {
      const entry = normalizePlanRow(database, projectRoot, row);
      if (entry) missing.push(entry);
    }
    recordMigration();
    database.run('COMMIT');
    inTransaction = false;
    if (missing.length > 0) {
      warn(`scrumlord migration v6: ${missing.length} task plan path(s) reference missing files:`);
      for (const entry of missing) warn(`  ${entry.id}: ${entry.path}`);
    }
  } catch (error) {
    if (inTransaction) {
      try {
        database.run('ROLLBACK');
      } catch {
        // ignore
      }
    }
    throw error;
  }
}

/**
 * Rebuilds `tasks` without the `archived` and `parent_id` columns. SQLite
 * rejects `ALTER TABLE ... DROP COLUMN` for FK columns, so we use the
 * table-rebuild pattern. Foreign keys must be disabled OUTSIDE a transaction
 * (an in-transaction `PRAGMA foreign_keys=OFF` is a no-op), otherwise
 * `DROP TABLE tasks` would cascade into the child tables. We validate via
 * `PRAGMA foreign_key_check` BEFORE committing so a violation rolls back
 * cleanly and v5 is not recorded.
 */
function runDropArchivedAndParent(context: MigrationRunContext): void {
  const { database, recordMigration } = context;
  database.run('PRAGMA foreign_keys = OFF;');
  let inTransaction = false;
  try {
    database.run('BEGIN');
    inTransaction = true;
    database.run(`
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'in-progress', 'in-review', 'completed')),
        description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL CHECK (priority IN (1, 2, 3)),
        created_at TEXT NOT NULL,
        start_date TEXT,
        due_date TEXT,
        last_modified_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        branch TEXT,
        plan TEXT,
        provider TEXT CHECK (provider IS NULL OR provider IN ('claude', 'codex')),
        session TEXT
      );

      INSERT INTO tasks_new (
        id, title, status, description, priority, created_at, start_date, due_date,
        last_modified_at, deleted, branch, plan, provider, session
      )
      SELECT
        id, title, status, description, priority, created_at, start_date, due_date,
        last_modified_at, deleted, branch, plan, provider, session
      FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      CREATE INDEX tasks_status_priority_index ON tasks(status, priority);
      CREATE INDEX tasks_branch_index ON tasks(branch);
      CREATE INDEX tasks_provider_session_index ON tasks(provider, session);
    `);
    const violations = database.query<unknown, []>('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new ScrumlordError(
        'migration_fk_violation',
        `v5 foreign_key_check returned ${violations.length} violation(s)`,
      );
    }
    recordMigration();
    database.run('COMMIT');
    inTransaction = false;
  } catch (error) {
    if (inTransaction) {
      try {
        database.run('ROLLBACK');
      } catch {
        // ignore rollback failure; original error is more important
      }
    }
    throw error;
  } finally {
    database.run('PRAGMA foreign_keys = ON;');
  }
}

/**
 * Introduces the shared-database project model. Adds a `projects` table and a
 * `NOT NULL project_id` foreign key on `tasks`. A plain
 * `ALTER TABLE tasks ADD COLUMN project_id INTEGER NOT NULL REFERENCES ...` is
 * invalid SQLite (a NOT NULL added column needs a non-null default, while a new
 * REFERENCES column with foreign keys on must default NULL), so we use the
 * table-rebuild pattern from v5.
 *
 * This migration only runs cleanly on an empty `tasks` table — the shared
 * database at `~/.scrumlord/tasks.db` starts empty and is populated by the
 * `import-legacy-databases` command, never by the migration. If pre-existing
 * rows are found we abort with `migration_unsafe` rather than inventing a
 * project for orphaned data.
 */
function runAddProjectsAndProjectScope(context: MigrationRunContext): void {
  const { database, recordMigration } = context;
  const existing = database
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM tasks')
    .get();
  if ((existing?.count ?? 0) > 0) {
    throw new ScrumlordError(
      'migration_unsafe',
      'v8 expected an empty tasks table in the shared database. Found existing rows; ' +
        'use `tasks import-legacy-databases` to populate the shared database instead.',
    );
  }

  database.run('PRAGMA foreign_keys = OFF;');
  let inTransaction = false;
  try {
    database.run('BEGIN');
    inTransaction = true;
    database.run(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name_with_owner TEXT NOT NULL,
        name_with_owner_key TEXT NOT NULL UNIQUE,
        repository_name_key TEXT NOT NULL,
        git_common_dir TEXT UNIQUE,
        remote_url TEXT,
        last_resolved_at TEXT
      );

      CREATE INDEX projects_repository_name_key_index ON projects(repository_name_key);

      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'in-progress', 'in-review', 'completed')),
        description TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL CHECK (priority IN (1, 2, 3)),
        created_at TEXT NOT NULL,
        start_date TEXT,
        due_date TEXT,
        last_modified_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
        branch TEXT,
        plan TEXT,
        provider TEXT CHECK (provider IS NULL OR provider IN ('claude', 'codex')),
        session TEXT,
        project_id INTEGER NOT NULL REFERENCES projects(id)
      );

      INSERT INTO tasks_new (
        id, title, status, description, priority, created_at, start_date, due_date,
        last_modified_at, deleted, branch, plan, provider, session, project_id
      )
      SELECT
        id, title, status, description, priority, created_at, start_date, due_date,
        last_modified_at, deleted, branch, plan, provider, session, NULL
      FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;

      CREATE INDEX tasks_status_priority_index ON tasks(status, priority);
      CREATE INDEX tasks_branch_index ON tasks(branch);
      CREATE INDEX tasks_provider_session_index ON tasks(provider, session);
      CREATE INDEX tasks_project_index ON tasks(project_id, status, priority);
    `);
    const violations = database.query<unknown, []>('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new ScrumlordError(
        'migration_fk_violation',
        `v8 foreign_key_check returned ${violations.length} violation(s)`,
      );
    }
    recordMigration();
    database.run('COMMIT');
    inTransaction = false;
  } catch (error) {
    if (inTransaction) {
      try {
        database.run('ROLLBACK');
      } catch {
        // ignore rollback failure; original error is more important
      }
    }
    throw error;
  } finally {
    database.run('PRAGMA foreign_keys = ON;');
  }
}

/** Applies all pending database migrations in version order. */
export const runMigrations = (
  database: Database,
  now: () => Date,
  options: { projectRoot: string; warn?: (message: string) => void } = {
    projectRoot: process.cwd(),
  },
): void => {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  database.run('PRAGMA foreign_keys = ON;');
  database.run(`
    CREATE TABLE IF NOT EXISTS task_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const isApplied = (version: number): boolean =>
    Boolean(
      database
        .query<
          { version: number },
          QueryBindings
        >('SELECT version FROM task_migrations WHERE version = $version')
        .get({ version }),
    );

  const recordMigrationRow = (migration: Migration): void => {
    database
      .query<
        unknown,
        QueryBindings
      >('INSERT INTO task_migrations (version, name, applied_at) VALUES ($version, $name, $appliedAt)')
      .run({ version: migration.version, name: migration.name, appliedAt: now().toISOString() });
  };

  // Process migrations strictly in version order. Standard migrations are
  // grouped into runs of consecutive entries so each run can share one
  // transaction; an own-transaction migration breaks the run, executes
  // itself, and the next standard run starts after it.
  let index = 0;
  while (index < migrations.length) {
    const start = index;
    while (index < migrations.length && migrations[index]?.requiresOwnTransaction !== true) {
      index += 1;
    }
    if (index > start) {
      const batch = migrations.slice(start, index) as StandardMigration[];
      const transaction = database.transaction(() => {
        for (const migration of batch) {
          if (isApplied(migration.version)) continue;
          database.run(migration.sql);
          recordMigrationRow(migration);
        }
      });
      transaction();
    }
    if (index < migrations.length) {
      const migration = migrations[index] as OwnTransactionMigration;
      if (!isApplied(migration.version)) {
        migration.run({
          database,
          now,
          projectRoot: options.projectRoot,
          recordMigration: () => recordMigrationRow(migration),
          warn,
        });
      }
      index += 1;
    }
  }
};
