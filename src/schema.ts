import type { Database } from 'bun:sqlite';
import { ScrumlordError } from './errors.js';

type QueryBindings = Record<string, string | number | null>;

/**
 * Context passed to migrations whose `run` callback needs more than the
 * database handle — currently the wall-clock `now` and a `recordMigration`
 * helper that inserts this migration's row into `task_migrations`.
 */
type MigrationRunContext = {
  database: Database;
  now: () => Date;
  recordMigration: () => void;
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
];

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

/** Applies all pending database migrations in version order. */
export const runMigrations = (database: Database, now: () => Date): void => {
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
          recordMigration: () => recordMigrationRow(migration),
        });
      }
      index += 1;
    }
  }
};
