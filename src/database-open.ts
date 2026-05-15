import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SqliteTaskStore } from './database.js';
import { ScrumlordError } from './errors.js';
import { resolveProjectRoot } from './root-resolution.js';
import { runMigrations } from './schema.js';
import type { TaskStore } from './types.js';

export type CreateTaskStoreOptions = {
  cwd?: string;
  now?: () => Date;
};

/** Resolves the project root, opens the task database, and runs pending migrations. */
export const createTaskStore = async (options: CreateTaskStoreOptions = {}): Promise<TaskStore> => {
  const now = options.now ?? (() => new Date());
  const projectRoot = await resolveProjectRoot(options.cwd);
  const databaseDirectory = join(projectRoot, 'tmp');
  try {
    mkdirSync(databaseDirectory, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError(
      'database_directory_failed',
      `Could not create task database directory ${databaseDirectory}: ${message}`,
    );
  }

  const databasePath = join(databaseDirectory, 'tasks.db');
  let database: Database;
  try {
    database = new Database(databasePath, { create: true, readwrite: true, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError(
      'database_open_failed',
      `Could not open task database ${databasePath}: ${message}`,
    );
  }

  try {
    runMigrations(database, now, { projectRoot });
  } catch (error) {
    database.close(false);
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError('migration_failed', `Could not run task migrations: ${message}`);
  }
  return new SqliteTaskStore(projectRoot, databasePath, database, now);
};
