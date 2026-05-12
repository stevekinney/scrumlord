import type { Database } from 'bun:sqlite';

type QueryBindings = Record<string, string | number | null>;

const migrations = [
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
] as const;

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

  const transaction = database.transaction(() => {
    for (const migration of migrations) {
      const applied = database
        .query<
          { version: number },
          QueryBindings
        >('SELECT version FROM task_migrations WHERE version = $version')
        .get({ version: migration.version });
      if (applied) continue;
      database.run(migration.sql);
      database
        .query<
          unknown,
          QueryBindings
        >('INSERT INTO task_migrations (version, name, applied_at) VALUES ($version, $name, $appliedAt)')
        .run({ version: migration.version, name: migration.name, appliedAt: now().toISOString() });
    }
  });

  transaction();
};
