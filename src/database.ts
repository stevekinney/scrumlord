import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ScrumlordError } from './errors.js';
import { resolveProjectRoot } from './root-resolution.js';
import { runMigrations } from './schema.js';
import type {
  CreateTaskInput,
  Task,
  TaskIdentifier,
  TaskPriority,
  TaskReference,
  TaskStatus,
  TaskStore,
  UpdateTaskInput,
} from './types.js';
import {
  normalizeTag,
  parseDateInput,
  parseOptionalText,
  parsePriority,
  parseStatus,
  requireTitle,
  taskIdFrom,
} from './validation.js';

type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  description: string;
  priority: TaskPriority;
  created_at: string;
  start_date: string | null;
  due_date: string | null;
  branch: string | null;
  last_modified_at: string;
  archived: number;
  deleted: number;
  parent_id: string | null;
};

type TaskDatabaseOptions = { cwd?: string; now?: () => Date };

type QueryBindings = Record<string, string | number | null>;

const booleanToInteger = (value: boolean): number => (value ? 1 : 0);

const validateDateOrder = (startDate: string | null, dueDate: string | null): void => {
  if (startDate && dueDate && dueDate < startDate) {
    throw new ScrumlordError('invalid_date_range', 'Due date cannot be before start date.');
  }
};

class SqliteTaskStore implements TaskStore {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(
    readonly projectRoot: string,
    readonly databasePath: string,
    database: Database,
    now: () => Date,
  ) {
    this.#database = database;
    this.#now = now;
  }

  create(input: CreateTaskInput): Task {
    const id = input.id ?? crypto.randomUUID();
    const now = this.#now().toISOString();
    const status = input.status ?? 'ready';
    const priority = parsePriority(input.priority ?? 1);
    const parsedStartDate = parseDateInput(input.startDate, 'startDate');
    const parsedDueDate = parseDateInput(input.dueDate, 'dueDate');
    const startDate = parsedStartDate === undefined ? null : parsedStartDate;
    const dueDate = parsedDueDate === undefined ? null : parsedDueDate;
    const branch = parseOptionalText(input.branch) ?? null;
    validateDateOrder(startDate, dueDate);
    if (this.getTask(id))
      throw new ScrumlordError('duplicate_task_id', `Task already exists: ${id}`);

    const transaction = this.#database.transaction(() => {
      this.#database
        .query<unknown, QueryBindings>(
          `INSERT INTO tasks (
            id, title, status, description, priority, created_at, start_date, due_date, branch, last_modified_at
          ) VALUES (
            $id, $title, $status, $description, $priority, $createdAt, $startDate, $dueDate, $branch, $lastModifiedAt
          )`,
        )
        .run({
          id,
          title: requireTitle(input.title),
          status: parseStatus(status),
          description: input.description ?? '',
          priority,
          createdAt: now,
          startDate,
          dueDate,
          branch,
          lastModifiedAt: now,
        });

      for (const tag of input.tags ?? []) this.insertTag(id, tag);
      if (input.parent) this.assignParent(id, taskIdFrom(input.parent));
      for (const blocker of input.blockedBy ?? []) this.insertBlocker(id, taskIdFrom(blocker));
    });

    transaction();
    return this.requireTask(id);
  }

  update(id: TaskIdentifier, input: UpdateTaskInput): Task {
    this.ensureTaskExists(id);
    const current = this.requireTask(id);
    const startDate =
      'startDate' in input
        ? (parseDateInput(input.startDate, 'startDate') ?? null)
        : current.startDate;
    const dueDate =
      'dueDate' in input ? (parseDateInput(input.dueDate, 'dueDate') ?? null) : current.dueDate;
    const branch = 'branch' in input ? (parseOptionalText(input.branch) ?? null) : current.branch;
    const now = this.#now().toISOString();
    validateDateOrder(startDate, dueDate);

    const transaction = this.#database.transaction(() => {
      this.#database
        .query<unknown, QueryBindings>(
          `UPDATE tasks SET
            title = $title,
            status = $status,
            description = $description,
            priority = $priority,
            start_date = $startDate,
            due_date = $dueDate,
            branch = $branch,
            archived = $archived,
            deleted = $deleted,
            last_modified_at = $lastModifiedAt
          WHERE id = $id`,
        )
        .run({
          id,
          title: input.title === undefined ? current.title : requireTitle(input.title),
          status: input.status === undefined ? current.status : parseStatus(input.status),
          description: input.description ?? current.description,
          priority: input.priority === undefined ? current.priority : parsePriority(input.priority),
          startDate,
          dueDate,
          branch,
          archived: booleanToInteger(input.archived ?? current.archived),
          deleted: booleanToInteger(input.deleted ?? current.deleted),
          lastModifiedAt: now,
        });

      if ('parent' in input) {
        if (input.parent === null) this.clearParentRow(id);
        if (input.parent) this.assignParent(id, taskIdFrom(input.parent));
      }
    });

    transaction();
    return this.requireTask(id);
  }

  delete(id: TaskIdentifier): Task {
    return this.update(id, { deleted: true });
  }

  archive(id: TaskIdentifier): Task {
    return this.update(id, { archived: true });
  }

  restore(id: TaskIdentifier): Task {
    return this.update(id, { archived: false, deleted: false });
  }

  getTask(id: TaskIdentifier): Task | null {
    const row = this.#database
      .query<TaskRow, QueryBindings>('SELECT * FROM tasks WHERE id = $id')
      .get({ id });
    return row ? this.hydrate(row) : null;
  }

  available(): Task[] {
    const now = this.#now().toISOString();
    return this.selectTasks(
      `SELECT * FROM tasks
       WHERE status = 'ready'
         AND deleted = 0
         AND archived = 0
         AND (start_date IS NULL OR start_date <= $now)
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies
           JOIN tasks AS blocker ON blocker.id = task_dependencies.blocked_by_task_id
           WHERE task_dependencies.task_id = tasks.id
             AND blocker.status != 'completed'
             AND blocker.deleted = 0
             AND blocker.archived = 0
         )
       ORDER BY priority DESC, created_at ASC, id ASC`,
      { now },
    );
  }

  blocked(): Task[] {
    return this.selectTasks(
      `SELECT DISTINCT tasks.* FROM tasks
       JOIN task_dependencies ON task_dependencies.task_id = tasks.id
       JOIN tasks AS blocker ON blocker.id = task_dependencies.blocked_by_task_id
       WHERE tasks.deleted = 0
         AND tasks.archived = 0
         AND blocker.status != 'completed'
         AND blocker.deleted = 0
         AND blocker.archived = 0
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
    );
  }

  completed(): Task[] {
    return this.selectTasks(
      "SELECT * FROM tasks WHERE status = 'completed' AND deleted = 0 ORDER BY last_modified_at DESC, id ASC",
    );
  }

  withTag(tag: string): Task[] {
    return this.selectTasks(
      `SELECT tasks.* FROM tasks
       JOIN task_tags ON task_tags.task_id = tasks.id
       WHERE task_tags.tag = $tag AND tasks.deleted = 0
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
      { tag: normalizeTag(tag) },
    );
  }

  withAllTags(...tags: string[]): Task[] {
    const normalizedTags = this.normalizeTagSet(tags);
    return this.selectTasks(
      `SELECT tasks.* FROM tasks
       JOIN task_tags ON task_tags.task_id = tasks.id
       WHERE task_tags.tag IN (${this.placeholders(normalizedTags)})
         AND tasks.deleted = 0
       GROUP BY tasks.id
       HAVING count(DISTINCT task_tags.tag) = $tagCount
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
      this.indexedBindings(normalizedTags, { tagCount: normalizedTags.length }),
    );
  }

  withAnyTag(...tags: string[]): Task[] {
    const normalizedTags = this.normalizeTagSet(tags);
    return this.selectTasks(
      `SELECT DISTINCT tasks.* FROM tasks
       JOIN task_tags ON task_tags.task_id = tasks.id
       WHERE task_tags.tag IN (${this.placeholders(normalizedTags)})
         AND tasks.deleted = 0
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
      this.indexedBindings(normalizedTags),
    );
  }

  withBranch(branch: string): Task[] {
    return this.selectTasks(
      'SELECT * FROM tasks WHERE branch = $branch AND deleted = 0 ORDER BY priority DESC, created_at ASC, id ASC',
      { branch },
    );
  }

  blockedBy(taskOrId: TaskReference): Task[] {
    return this.selectTasks(
      `SELECT blocker.* FROM task_dependencies
       JOIN tasks AS blocker ON blocker.id = task_dependencies.blocked_by_task_id
       WHERE task_dependencies.task_id = $id AND blocker.deleted = 0
       ORDER BY blocker.priority DESC, blocker.created_at ASC, blocker.id ASC`,
      { id: taskIdFrom(taskOrId) },
    );
  }

  blocking(taskOrId: TaskReference): Task[] {
    return this.selectTasks(
      `SELECT tasks.* FROM task_dependencies
       JOIN tasks ON tasks.id = task_dependencies.task_id
       WHERE task_dependencies.blocked_by_task_id = $id AND tasks.deleted = 0
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
      { id: taskIdFrom(taskOrId) },
    );
  }

  withPriority(priority: number): Task[] {
    return this.selectTasks(
      'SELECT * FROM tasks WHERE priority = $priority AND deleted = 0 ORDER BY created_at ASC, id ASC',
      { priority: parsePriority(priority) },
    );
  }

  next(): Task | null {
    return this.available()[0] ?? null;
  }

  cleanup(days: number): { deleted: number } {
    if (!Number.isInteger(days) || days < 0) {
      throw new ScrumlordError(
        'invalid_cleanup_days',
        'Cleanup days must be a non-negative integer.',
      );
    }

    const cutoff = new Date(this.#now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = this.#database
      .query<unknown, QueryBindings>(
        `DELETE FROM tasks
         WHERE (status = 'completed' OR archived = 1)
           AND last_modified_at < $cutoff`,
      )
      .run({ cutoff });

    return { deleted: result.changes };
  }

  addTag(id: TaskIdentifier, tag: string): Task {
    this.ensureTaskExists(id);
    this.insertTag(id, tag);
    this.touch(id);
    return this.requireTask(id);
  }

  removeTag(id: TaskIdentifier, tag: string): Task {
    this.ensureTaskExists(id);
    this.#database
      .query<unknown, QueryBindings>('DELETE FROM task_tags WHERE task_id = $id AND tag = $tag')
      .run({ id, tag: normalizeTag(tag) });
    this.touch(id);
    return this.requireTask(id);
  }

  setParent(id: TaskIdentifier, parent: TaskReference): Task {
    this.ensureTaskExists(id);
    this.assignParent(id, taskIdFrom(parent));
    this.touch(id);
    return this.requireTask(id);
  }

  clearParent(id: TaskIdentifier): Task {
    this.ensureTaskExists(id);
    this.clearParentRow(id);
    this.touch(id);
    return this.requireTask(id);
  }

  addBlocker(id: TaskIdentifier, blockedBy: TaskReference): Task {
    this.ensureTaskExists(id);
    this.insertBlocker(id, taskIdFrom(blockedBy));
    this.touch(id);
    return this.requireTask(id);
  }

  removeBlocker(id: TaskIdentifier, blockedBy: TaskReference): Task {
    this.ensureTaskExists(id);
    this.#database
      .query<
        unknown,
        QueryBindings
      >('DELETE FROM task_dependencies WHERE task_id = $id AND blocked_by_task_id = $blockedBy')
      .run({ id, blockedBy: taskIdFrom(blockedBy) });
    this.touch(id);
    return this.requireTask(id);
  }

  close(): void {
    this.#database.close(false);
  }

  private selectTasks(sql: string, bindings: QueryBindings = {}): Task[] {
    return this.#database
      .query<TaskRow, QueryBindings>(sql)
      .all(bindings)
      .map((row) => this.hydrate(row));
  }

  private hydrate(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      description: row.description,
      priority: row.priority,
      createdAt: row.created_at,
      startDate: row.start_date,
      dueDate: row.due_date,
      branch: row.branch,
      tags: this.values('SELECT tag FROM task_tags WHERE task_id = $id ORDER BY tag ASC', row.id),
      parent: row.parent_id,
      subtasks: this.values(
        'SELECT id FROM tasks WHERE parent_id = $id ORDER BY created_at ASC, id ASC',
        row.id,
      ),
      blockedBy: this.values(
        'SELECT blocked_by_task_id AS id FROM task_dependencies WHERE task_id = $id ORDER BY blocked_by_task_id ASC',
        row.id,
      ),
      blocking: this.values(
        'SELECT task_id AS id FROM task_dependencies WHERE blocked_by_task_id = $id ORDER BY task_id ASC',
        row.id,
      ),
      lastModifiedAt: row.last_modified_at,
      archived: row.archived === 1,
      deleted: row.deleted === 1,
    };
  }

  private values(sql: string, id: string): string[] {
    return this.#database
      .query<{ id?: string; tag?: string }, QueryBindings>(sql)
      .all({ id })
      .map((row) => row.id ?? row.tag ?? '');
  }

  private requireTask(id: TaskIdentifier): Task {
    const task = this.getTask(id);
    if (!task) throw new ScrumlordError('task_not_found', `Task not found: ${id}`);
    return task;
  }

  private ensureTaskExists(id: TaskIdentifier): void {
    this.requireTask(id);
  }

  private insertTag(id: TaskIdentifier, tag: string): void {
    this.#database
      .query('INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES ($id, $tag)')
      .run({ id, tag: normalizeTag(tag) });
  }

  private assignParent(id: TaskIdentifier, parent: TaskIdentifier): void {
    if (id === parent)
      throw new ScrumlordError('invalid_parent', 'A task cannot be its own parent.');
    this.ensureTaskExists(parent);
    if (this.hasParentPath(parent, id)) {
      throw new ScrumlordError('parent_cycle', 'Parent relationships cannot create a cycle.');
    }
    this.#database
      .query<unknown, QueryBindings>('UPDATE tasks SET parent_id = $parent WHERE id = $id')
      .run({ id, parent });
  }

  private clearParentRow(id: TaskIdentifier): void {
    this.#database
      .query<unknown, QueryBindings>('UPDATE tasks SET parent_id = NULL WHERE id = $id')
      .run({ id });
  }

  private insertBlocker(id: TaskIdentifier, blockedBy: TaskIdentifier): void {
    if (id === blockedBy)
      throw new ScrumlordError('invalid_dependency', 'A task cannot block itself.');
    this.ensureTaskExists(blockedBy);
    if (this.hasBlockerPath(blockedBy, id)) {
      throw new ScrumlordError('dependency_cycle', 'Task dependencies cannot create a cycle.');
    }
    this.#database
      .query(
        'INSERT OR IGNORE INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($id, $blockedBy)',
      )
      .run({ id, blockedBy });
  }

  private hasParentPath(start: string, target: string): boolean {
    return Boolean(
      this.#database
        .query<{ id: string }, QueryBindings>(
          `WITH RECURSIVE parents(id) AS (
            SELECT parent_id FROM tasks WHERE id = $start AND parent_id IS NOT NULL
            UNION
            SELECT tasks.parent_id FROM tasks JOIN parents ON tasks.id = parents.id
            WHERE tasks.parent_id IS NOT NULL
          )
          SELECT id FROM parents WHERE id = $target LIMIT 1`,
        )
        .get({ start, target }),
    );
  }

  private hasBlockerPath(start: string, target: string): boolean {
    return Boolean(
      this.#database
        .query<{ id: string }, QueryBindings>(
          `WITH RECURSIVE blockers(id) AS (
            SELECT blocked_by_task_id FROM task_dependencies WHERE task_id = $start
            UNION
            SELECT task_dependencies.blocked_by_task_id
            FROM task_dependencies JOIN blockers ON task_dependencies.task_id = blockers.id
          )
          SELECT id FROM blockers WHERE id = $target LIMIT 1`,
        )
        .get({ start, target }),
    );
  }

  private touch(id: TaskIdentifier): void {
    this.#database
      .query('UPDATE tasks SET last_modified_at = $lastModifiedAt WHERE id = $id')
      .run({ id, lastModifiedAt: this.#now().toISOString() });
  }

  private normalizeTagSet(tags: string[]): string[] {
    const normalized = Array.from(new Set(tags.map((tag) => normalizeTag(tag))));
    if (normalized.length === 0)
      throw new ScrumlordError('invalid_tags', 'At least one tag is required.');
    return normalized;
  }

  private placeholders(values: string[]): string {
    return values.map((_value, index) => `$value${index}`).join(', ');
  }

  private indexedBindings(values: string[], extra: QueryBindings = {}): QueryBindings {
    return values.reduce<QueryBindings>((bindings, value, index) => {
      bindings[`value${index}`] = value;
      return bindings;
    }, extra);
  }
}

export const createTaskStore = async (options: TaskDatabaseOptions = {}): Promise<TaskStore> => {
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
    runMigrations(database, now);
  } catch (error) {
    database.close(false);
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError('migration_failed', `Could not run task migrations: ${message}`);
  }
  return new SqliteTaskStore(projectRoot, databasePath, database, now);
};
