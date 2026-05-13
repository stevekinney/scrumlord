/* eslint-disable max-lines */
import { Database } from 'bun:sqlite';
import {
  availableTasksSql,
  blockedTasksSql,
  createTaskProgressBindings,
  createTaskBindings,
  hasBlockerPath,
  hasParentPath,
  hydrateTaskProgress,
  hydrateTask,
  indexedBindings,
  listCandidatesSql,
  nextTaskSql,
  normalizeTagSet,
  placeholders,
  remainingTasksSql,
  updateTaskBindings,
  type QueryBindings,
  type TaskProgressRow,
  type TaskRow,
} from './database-support.js';
import { ScrumlordError } from './errors.js';
import { formatPipelinePhaseMarker, parsePipelineRunId } from './pipeline-markers.js';
import type {
  AddTaskProgressInput,
  AgentProvider,
  ClaimNextOptions,
  ConditionalUpdatePredicate,
  CreateTaskInput,
  PersistedTaskSession,
  Task,
  TaskIdentifier,
  TaskProgress,
  TaskPriority,
  TaskReference,
  TaskStore,
  UpdateTaskInput,
} from './types.js';
import { normalizeTag, parsePriority, taskIdFrom } from './validation.js';

export class SqliteTaskStore implements TaskStore {
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
    if (this.getTask(id))
      throw new ScrumlordError('duplicate_task_id', `Task already exists: ${id}`);

    const bindings = createTaskBindings(this.projectRoot, input, id, now);
    const transaction = this.#database.transaction(() => {
      this.#database
        .query<unknown, QueryBindings>(
          `INSERT INTO tasks (
            id, title, status, description, priority, created_at, start_date, due_date, branch, plan, provider, session, last_modified_at
          ) VALUES (
            $id, $title, $status, $description, $priority, $createdAt, $startDate, $dueDate, $branch, $plan, $provider, $session, $lastModifiedAt
          )`,
        )
        .run(bindings);

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
    const now = this.#now().toISOString();
    const bindings = updateTaskBindings(this.projectRoot, id, input, current, now);

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
            plan = $plan,
            provider = $provider,
            session = $session,
            archived = $archived,
            deleted = $deleted,
            last_modified_at = $lastModifiedAt
          WHERE id = $id`,
        )
        .run(bindings);

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

  list(options: { includeInactive?: boolean } = {}): Task[] {
    if (options.includeInactive) {
      return this.selectTasks('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC, id ASC');
    }
    return this.selectTasks(
      'SELECT * FROM tasks WHERE deleted = 0 AND archived = 0 ORDER BY priority DESC, created_at ASC, id ASC',
    );
  }

  available(): Task[] {
    const now = this.#now().toISOString();
    return this.selectTasks(availableTasksSql, { now });
  }

  blocked(): Task[] {
    return this.selectTasks(blockedTasksSql);
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
    const normalizedTags = normalizeTagSet(tags);
    return this.selectTasks(
      `SELECT tasks.* FROM tasks
       JOIN task_tags ON task_tags.task_id = tasks.id
       WHERE task_tags.tag IN (${placeholders(normalizedTags)})
         AND tasks.deleted = 0
       GROUP BY tasks.id
       HAVING count(DISTINCT task_tags.tag) = $tagCount
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
      indexedBindings(normalizedTags, { tagCount: normalizedTags.length }),
    );
  }

  withAnyTag(...tags: string[]): Task[] {
    const normalizedTags = normalizeTagSet(tags);
    return this.selectTasks(
      `SELECT DISTINCT tasks.* FROM tasks
       JOIN task_tags ON task_tags.task_id = tasks.id
       WHERE task_tags.tag IN (${placeholders(normalizedTags)})
         AND tasks.deleted = 0
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
      indexedBindings(normalizedTags),
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

  withPriority(priority: TaskPriority): Task[] {
    return this.selectTasks(
      'SELECT * FROM tasks WHERE priority = $priority AND deleted = 0 ORDER BY created_at ASC, id ASC',
      { priority: parsePriority(priority) },
    );
  }

  next(): Task | null {
    const now = this.#now().toISOString();
    return this.selectTasks(nextTaskSql, { now })[0] ?? null;
  }

  claimNext(options: ClaimNextOptions): Task | null {
    const now = this.#now().toISOString();
    let claimedId: TaskIdentifier | null = null;
    const transaction = this.#database.transaction(() => {
      const candidate = this.selectTasks(nextTaskSql, { now })[0];
      if (!candidate) return;
      claimedId = candidate.id;
      const marker = formatPipelinePhaseMarker('claim', candidate.id, options.runId, now);
      this.#database
        .query<
          unknown,
          QueryBindings
        >(`UPDATE tasks SET status = 'in-progress', last_modified_at = $lastModifiedAt WHERE id = $id`)
        .run({ id: candidate.id, lastModifiedAt: now });
      this.#database
        .query<unknown, QueryBindings>(
          `INSERT INTO task_progress (
            id, task_id, message, created_at, provider, session
          ) VALUES (
            $id, $taskId, $message, $createdAt, $provider, $session
          )`,
        )
        .run({
          id: crypto.randomUUID(),
          taskId: candidate.id,
          message: marker,
          createdAt: now,
          provider: null,
          session: null,
        });
    });
    transaction();
    return claimedId ? this.requireTask(claimedId) : null;
  }

  listClaimCandidates(limit: number, excludeIds: Set<TaskIdentifier> = new Set()): Task[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const now = this.#now().toISOString();
    const overscan = Math.max(limit + excludeIds.size, limit);
    const rows = this.selectTasks(listCandidatesSql, { now, limit: overscan });
    const out: Task[] = [];
    for (const row of rows) {
      if (excludeIds.has(row.id)) continue;
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  }

  conditionalUpdate(
    id: TaskIdentifier,
    patch: UpdateTaskInput,
    predicate: ConditionalUpdatePredicate,
  ): Task | null {
    let result: Task | null = null;
    const transaction = this.#database.transaction(() => {
      const current = this.getTask(id);
      if (!current) return;
      if (predicate.ifStatus !== undefined && current.status !== predicate.ifStatus) return;
      if (predicate.ifBranch !== undefined && current.branch !== predicate.ifBranch) return;
      if (predicate.ifRunId !== undefined) {
        const runId = this.latestPipelineRunId(id);
        if (runId !== predicate.ifRunId) return;
      }
      result = this.update(id, patch);
    });
    transaction();
    return result;
  }

  private latestPipelineRunId(id: TaskIdentifier): string | null {
    const row = this.#database
      .query<{ message: string }, QueryBindings>(
        `SELECT message FROM task_progress
         WHERE task_id = $id AND message LIKE 'pipeline:phase=%'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get({ id });
    if (!row) return null;
    return parsePipelineRunId(row.message);
  }

  remaining(): number {
    const row = this.#database.query<{ count: number }, []>(remainingTasksSql).get();
    return row?.count ?? 0;
  }

  summarizeReadyQueue(): {
    draft: number;
    ready: number;
    inProgress: number;
    inReview: number;
    completed: number;
    blocked: number;
  } {
    const rows = this.#database
      .query<
        { status: string; count: number },
        []
      >('SELECT status, COUNT(*) AS count FROM tasks WHERE deleted = 0 AND archived = 0 GROUP BY status')
      .all();
    const counts = { draft: 0, ready: 0, inProgress: 0, inReview: 0, completed: 0 };
    for (const row of rows) {
      if (row.status === 'draft') counts.draft = row.count;
      else if (row.status === 'ready') counts.ready = row.count;
      else if (row.status === 'in-progress') counts.inProgress = row.count;
      else if (row.status === 'in-review') counts.inReview = row.count;
      else if (row.status === 'completed') counts.completed = row.count;
    }
    const blocked = this.blocked().length;
    return { ...counts, blocked };
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

  setPlan(id: TaskIdentifier, plan: string | null): Task {
    return this.update(id, { plan });
  }

  setSession(id: TaskIdentifier, provider: AgentProvider, session: string | null): Task {
    return this.update(id, { provider, session });
  }

  withSession(provider: AgentProvider, session: string): Task[] {
    return this.selectTasks(
      `SELECT * FROM tasks
       WHERE provider = $provider AND session = $session AND deleted = 0
       ORDER BY last_modified_at DESC, id ASC`,
      { provider, session },
    );
  }

  taskSession(id: TaskIdentifier): PersistedTaskSession {
    const task = this.requireTask(id);
    return {
      taskId: task.id,
      provider: task.provider,
      session: task.session,
      branch: task.branch,
      plan: task.plan,
    };
  }

  progress(id: TaskIdentifier): TaskProgress[] {
    this.ensureTaskExists(id);
    return this.#database
      .query<
        TaskProgressRow,
        QueryBindings
      >('SELECT * FROM task_progress WHERE task_id = $id ORDER BY created_at ASC, id ASC')
      .all({ id })
      .map(hydrateTaskProgress);
  }

  addProgress(id: TaskIdentifier, input: AddTaskProgressInput): TaskProgress {
    const task = this.requireTask(id);
    const progressId = input.id ?? crypto.randomUUID();
    const now = this.#now().toISOString();
    const bindings = createTaskProgressBindings(input, task, progressId, now);

    const transaction = this.#database.transaction(() => {
      this.#database
        .query<unknown, QueryBindings>(
          `INSERT INTO task_progress (
            id, task_id, message, created_at, provider, session
          ) VALUES (
            $id, $taskId, $message, $createdAt, $provider, $session
          )`,
        )
        .run(bindings);
      if (task.status === 'draft' || task.status === 'ready') {
        this.#database
          .query(
            `UPDATE tasks
             SET status = 'in-progress', last_modified_at = $lastModifiedAt
             WHERE id = $id`,
          )
          .run({ id, lastModifiedAt: now });
      } else {
        this.touchAt(id, now);
      }
    });

    transaction();
    return this.requireProgress(progressId);
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
    return hydrateTask(row, {
      tags: this.values('SELECT tag FROM task_tags WHERE task_id = $id ORDER BY tag ASC', row.id),
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
    });
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

  private requireProgress(id: string): TaskProgress {
    const row = this.#database
      .query<TaskProgressRow, QueryBindings>('SELECT * FROM task_progress WHERE id = $id')
      .get({ id });
    if (!row) throw new ScrumlordError('progress_not_found', `Progress not found: ${id}`);
    return hydrateTaskProgress(row);
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
    if (hasParentPath(this.#database, parent, id)) {
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
    if (hasBlockerPath(this.#database, blockedBy, id)) {
      throw new ScrumlordError('dependency_cycle', 'Task dependencies cannot create a cycle.');
    }
    this.#database
      .query(
        'INSERT OR IGNORE INTO task_dependencies (task_id, blocked_by_task_id) VALUES ($id, $blockedBy)',
      )
      .run({ id, blockedBy });
  }

  private touch(id: TaskIdentifier): void {
    this.touchAt(id, this.#now().toISOString());
  }

  private touchAt(id: TaskIdentifier, lastModifiedAt: string): void {
    this.#database
      .query('UPDATE tasks SET last_modified_at = $lastModifiedAt WHERE id = $id')
      .run({ id, lastModifiedAt });
  }
}
