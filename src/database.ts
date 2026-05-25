/* eslint-disable max-lines */
import { Database } from 'bun:sqlite';
import {
  availableTasksSql,
  blockedTasksSql,
  createTaskProgressBindings,
  createTaskBindings,
  hasBlockerPath,
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
import type { RecoverOrphanInput, RecoverOrphanResult } from './orphan-recovery.js';
import type {
  AddTaskProgressInput,
  AgentProvider,
  ClaimNextOptions,
  ConditionalUpdatePredicate,
  CleanupOptions,
  CreateTaskInput,
  DeleteOptions,
  PersistedTaskSession,
  Task,
  TaskBlocker,
  TaskIdentifier,
  TaskProgress,
  TaskPriority,
  TaskReference,
  TaskStatus,
  TaskStore,
  UpdateTaskInput,
} from './types.js';
import { normalizeTag, parsePriority, taskIdFrom } from './validation.js';

export class SqliteTaskStore implements TaskStore {
  readonly #database: Database;
  readonly #now: () => Date;
  /**
   * Surrogate id of the project this store is scoped to, or `null` when the
   * project could not be resolved. Every command-facing query filters on it;
   * a `null` scope binds `project_id = NULL`, which never matches, so reads
   * return nothing and writes are rejected by {@link requireProjectScope}.
   */
  readonly #projectId: number | null;

  constructor(
    readonly projectRoot: string,
    readonly databasePath: string,
    database: Database,
    now: () => Date,
    projectId: number | null,
    readonly projectGitCommonDir: string | null = null,
  ) {
    this.#database = database;
    this.#now = now;
    this.#projectId = projectId;
    this.projectResolved = projectId !== null;
  }

  /** Whether a project scope was resolved for this store. */
  readonly projectResolved: boolean;

  /** Returns the resolved project id, or throws `project_unresolved` for writes. */
  private requireProjectScope(): number {
    if (this.#projectId === null) {
      throw new ScrumlordError(
        'project_unresolved',
        'Could not determine the current project. Run inside a git repository with an ' +
          'authenticated `gh`, or pass --project owner/repo.',
      );
    }
    return this.#projectId;
  }

  create(input: CreateTaskInput): Task {
    const projectId = this.requireProjectScope();
    const id = input.id ?? crypto.randomUUID();
    const now = this.#now().toISOString();
    if (this.getTaskGlobally(id))
      throw new ScrumlordError('duplicate_task_id', `Task already exists: ${id}`);

    const bindings = { ...createTaskBindings(this.projectRoot, input, id, now), projectId };
    const transaction = this.#database.transaction(() => {
      this.#database
        .query<unknown, QueryBindings>(
          `INSERT INTO tasks (
            id, title, status, description, priority, created_at, start_date, due_date, branch, plan, provider, session, last_modified_at, project_id
          ) VALUES (
            $id, $title, $status, $description, $priority, $createdAt, $startDate, $dueDate, $branch, $plan, $provider, $session, $lastModifiedAt, $projectId
          )`,
        )
        .run(bindings);

      for (const tag of input.tags ?? []) this.insertTag(id, tag);
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
          deleted = $deleted,
          last_modified_at = $lastModifiedAt
        WHERE id = $id`,
      )
      .run(bindings);

    return this.requireTask(id);
  }

  delete(id: TaskIdentifier, options: DeleteOptions = {}): Task | null {
    this.ensureTaskExists(id);
    const now = this.#now().toISOString();
    if (options.hard) return this.runHardDelete(id, now);
    return this.runSoftDelete(id, now);
  }

  private dependencyNeighbors(id: TaskIdentifier): TaskIdentifier[] {
    const rows = this.#database
      .query<{ neighbor: string }, QueryBindings>(
        `SELECT DISTINCT blocked_by_task_id AS neighbor FROM task_dependencies WHERE task_id = $id
         UNION
         SELECT DISTINCT task_id AS neighbor FROM task_dependencies WHERE blocked_by_task_id = $id`,
      )
      .all({ id });
    return rows.map((row) => row.neighbor).filter((neighbor) => neighbor !== id);
  }

  private runSoftDelete(id: TaskIdentifier, now: string): Task {
    let result: Task | null = null;
    const transaction = this.#database.transaction(() => {
      const neighbors = this.dependencyNeighbors(id);
      this.#database
        .query<
          unknown,
          QueryBindings
        >('DELETE FROM task_dependencies WHERE task_id = $id OR blocked_by_task_id = $id')
        .run({ id });
      result = this.update(id, { deleted: true });
      for (const neighborId of neighbors) this.touchAt(neighborId, now);
    });
    transaction();
    return result ?? this.requireTask(id);
  }

  private runHardDelete(id: TaskIdentifier, now: string): null {
    const transaction = this.#database.transaction(() => {
      const neighbors = this.dependencyNeighbors(id);
      this.#database.query<unknown, QueryBindings>('DELETE FROM tasks WHERE id = $id').run({ id });
      for (const neighborId of neighbors) this.touchAt(neighborId, now);
    });
    transaction();
    return null;
  }

  getTask(id: TaskIdentifier): Task | null {
    const row = this.#database
      .query<
        TaskRow,
        QueryBindings
      >('SELECT * FROM tasks WHERE id = $id AND project_id = $projectId')
      .get({ id, projectId: this.#projectId });
    return row ? this.hydrate(row) : null;
  }

  /**
   * Looks up a task by id across every project, ignoring the store's scope.
   * Reserved for cross-project tooling (the legacy-database importer and the
   * duplicate-id guard) — never use it on a command path, or one project's
   * command could read or mutate another's task by id.
   */
  getTaskGlobally(id: TaskIdentifier): Task | null {
    const row = this.#database
      .query<TaskRow, QueryBindings>('SELECT * FROM tasks WHERE id = $id')
      .get({ id });
    return row ? this.hydrate(row) : null;
  }

  list(options: { includeInactive?: boolean } = {}): Task[] {
    if (options.includeInactive) {
      return this.selectTasks(
        'SELECT * FROM tasks WHERE project_id = $projectId ORDER BY priority DESC, created_at ASC, id ASC',
      );
    }
    return this.selectTasks(
      'SELECT * FROM tasks WHERE project_id = $projectId AND deleted = 0 ORDER BY priority DESC, created_at ASC, id ASC',
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
      "SELECT * FROM tasks WHERE project_id = $projectId AND status = 'completed' AND deleted = 0 ORDER BY last_modified_at DESC, id ASC",
    );
  }

  withTag(tag: string): Task[] {
    return this.selectTasks(
      `SELECT tasks.* FROM tasks
       JOIN task_tags ON task_tags.task_id = tasks.id
       WHERE tasks.project_id = $projectId AND task_tags.tag = $tag AND tasks.deleted = 0
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
      { tag: normalizeTag(tag) },
    );
  }

  withAllTags(...tags: string[]): Task[] {
    const normalizedTags = normalizeTagSet(tags);
    return this.selectTasks(
      `SELECT tasks.* FROM tasks
       JOIN task_tags ON task_tags.task_id = tasks.id
       WHERE tasks.project_id = $projectId
         AND task_tags.tag IN (${placeholders(normalizedTags)})
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
       WHERE tasks.project_id = $projectId
         AND task_tags.tag IN (${placeholders(normalizedTags)})
         AND tasks.deleted = 0
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
      indexedBindings(normalizedTags),
    );
  }

  withBranch(branch: string): Task[] {
    return this.selectTasks(
      'SELECT * FROM tasks WHERE project_id = $projectId AND branch = $branch AND deleted = 0 ORDER BY priority DESC, created_at ASC, id ASC',
      { branch },
    );
  }

  blockedBy(taskOrId: TaskReference): Task[] {
    return this.selectTasks(
      `SELECT blocker.* FROM task_dependencies
       JOIN tasks AS blocker ON blocker.id = task_dependencies.blocked_by_task_id
       WHERE task_dependencies.task_id = $id AND blocker.project_id = $projectId AND blocker.deleted = 0
       ORDER BY blocker.priority DESC, blocker.created_at ASC, blocker.id ASC`,
      { id: taskIdFrom(taskOrId) },
    );
  }

  blocking(taskOrId: TaskReference): Task[] {
    return this.selectTasks(
      `SELECT tasks.* FROM task_dependencies
       JOIN tasks ON tasks.id = task_dependencies.task_id
       WHERE task_dependencies.blocked_by_task_id = $id AND tasks.project_id = $projectId AND tasks.deleted = 0
       ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`,
      { id: taskIdFrom(taskOrId) },
    );
  }

  withPriority(priority: TaskPriority): Task[] {
    return this.selectTasks(
      'SELECT * FROM tasks WHERE project_id = $projectId AND priority = $priority AND deleted = 0 ORDER BY created_at ASC, id ASC',
      { priority: parsePriority(priority) },
    );
  }

  withStatus(status: TaskStatus): Task[] {
    return this.selectTasks(
      'SELECT * FROM tasks WHERE project_id = $projectId AND status = $status AND deleted = 0 ORDER BY priority DESC, created_at ASC, id ASC',
      { status },
    );
  }

  next(): Task | null {
    const now = this.#now().toISOString();
    return this.selectTasks(nextTaskSql, { now })[0] ?? null;
  }

  claimNext(options: ClaimNextOptions): Task | null {
    const now = this.#now().toISOString();
    let claimedId: TaskIdentifier | null = null;
    // IMMEDIATE so two agents racing for the same next task across the shared
    // database cannot both read it as available before either writes the claim.
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
            id, task_id, message, created_at, provider, session,
            event, tool, cwd, transcript_path, commit_sha
          ) VALUES (
            $id, $taskId, $message, $createdAt, $provider, $session,
            $event, $tool, $cwd, $transcriptPath, $commitSha
          )`,
        )
        .run({
          id: crypto.randomUUID(),
          taskId: candidate.id,
          message: marker,
          createdAt: now,
          provider: null,
          session: null,
          event: null,
          tool: null,
          cwd: null,
          transcriptPath: null,
          commitSha: null,
        });
    });
    transaction.immediate();
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
    const row = this.#database
      .query<{ count: number }, QueryBindings>(remainingTasksSql)
      .get({ projectId: this.#projectId });
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
        QueryBindings
      >('SELECT status, COUNT(*) AS count FROM tasks WHERE project_id = $projectId AND deleted = 0 GROUP BY status')
      .all({ projectId: this.#projectId });
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

  cleanup(days: number, options: CleanupOptions = {}): { deleted: number } {
    if (!Number.isInteger(days) || days < 0) {
      throw new ScrumlordError(
        'invalid_cleanup_days',
        'Cleanup days must be a non-negative integer.',
      );
    }
    const now = this.#now().toISOString();
    const cutoff = new Date(this.#now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    return options.hard ? this.runHardCleanup(cutoff, now) : this.runSoftCleanup(cutoff, now);
  }

  private affectedNeighbors(targetIds: Set<TaskIdentifier>): TaskIdentifier[] {
    if (targetIds.size === 0) return [];
    const ids = [...targetIds];
    const params = ids.map((_id, index) => `$id${index}`).join(', ');
    const bindings: QueryBindings = {};
    ids.forEach((id, index) => {
      bindings[`id${index}`] = id;
    });
    const rows = this.#database
      .query<{ neighbor: string }, QueryBindings>(
        `SELECT DISTINCT blocked_by_task_id AS neighbor FROM task_dependencies WHERE task_id IN (${params})
         UNION
         SELECT DISTINCT task_id AS neighbor FROM task_dependencies WHERE blocked_by_task_id IN (${params})`,
      )
      .all(bindings);
    return rows.map((row) => row.neighbor).filter((neighbor) => !targetIds.has(neighbor));
  }

  private runSoftCleanup(cutoff: string, now: string): { deleted: number } {
    let deleted = 0;
    const transaction = this.#database.transaction(() => {
      const targets = new Set(
        this.#database
          .query<{ id: string }, QueryBindings>(
            `SELECT id FROM tasks
             WHERE project_id = $projectId AND status = 'completed' AND deleted = 0 AND last_modified_at < $cutoff`,
          )
          .all({ cutoff, projectId: this.#projectId })
          .map((row) => row.id),
      );
      if (targets.size === 0) return;
      deleted = targets.size;
      const neighbors = this.affectedNeighbors(targets);
      for (const id of targets) {
        this.#database
          .query<
            unknown,
            QueryBindings
          >('DELETE FROM task_dependencies WHERE task_id = $id OR blocked_by_task_id = $id')
          .run({ id });
      }
      this.#database
        .query<unknown, QueryBindings>(
          `UPDATE tasks SET deleted = 1, last_modified_at = $now
           WHERE id IN (${[...targets].map((_id, index) => `$id${index}`).join(', ')})`,
        )
        .run(
          [...targets].reduce<QueryBindings>(
            (bindings, id, index) => {
              bindings[`id${index}`] = id;
              return bindings;
            },
            { now } satisfies QueryBindings,
          ),
        );
      for (const id of neighbors) this.touchAt(id, now);
    });
    transaction();
    return { deleted };
  }

  private runHardCleanup(cutoff: string, now: string): { deleted: number } {
    let deleted = 0;
    const transaction = this.#database.transaction(() => {
      const targets = new Set(
        this.#database
          .query<{ id: string }, QueryBindings>(
            `SELECT id FROM tasks
             WHERE project_id = $projectId AND (status = 'completed' OR deleted = 1) AND last_modified_at < $cutoff`,
          )
          .all({ cutoff, projectId: this.#projectId })
          .map((row) => row.id),
      );
      if (targets.size === 0) return;
      deleted = targets.size;
      const neighbors = this.affectedNeighbors(targets);
      const ids = [...targets];
      this.#database
        .query<
          unknown,
          QueryBindings
        >(`DELETE FROM tasks WHERE id IN (${ids.map((_id, index) => `$id${index}`).join(', ')})`)
        .run(
          ids.reduce<QueryBindings>((bindings, id, index) => {
            bindings[`id${index}`] = id;
            return bindings;
          }, {}),
        );
      for (const id of neighbors) this.touchAt(id, now);
    });
    transaction();
    return { deleted };
  }

  /** Returns tasks whose branch does not exist in Git and can be demoted back to ready. */
  inProgress(): Task[] {
    return this.selectTasks(
      "SELECT * FROM tasks WHERE project_id = $projectId AND status = 'in-progress' AND deleted = 0 ORDER BY last_modified_at DESC",
    );
  }

  /** Returns the count of non-deleted in-progress tasks. */
  countInProgress(): number {
    const row = this.#database
      .query<
        { count: number },
        QueryBindings
      >("SELECT COUNT(*) as count FROM tasks WHERE project_id = $projectId AND status = 'in-progress' AND deleted = 0")
      .get({ projectId: this.#projectId });
    return row?.count ?? 0;
  }

  /** Returns the count of non-deleted tasks with a non-empty recorded branch. */
  countBranched(): number {
    const row = this.#database
      .query<
        { count: number },
        QueryBindings
      >("SELECT COUNT(*) as count FROM tasks WHERE project_id = $projectId AND deleted = 0 AND branch IS NOT NULL AND TRIM(branch) != ''")
      .get({ projectId: this.#projectId });
    return row?.count ?? 0;
  }

  /** Returns the IDs that would be deleted by cleanup without mutating anything. */
  previewCleanup(days: number, options: CleanupOptions = {}): { wouldDelete: TaskIdentifier[] } {
    if (!Number.isInteger(days) || days < 0) {
      throw new ScrumlordError(
        'invalid_cleanup_days',
        'Cleanup days must be a non-negative integer.',
      );
    }
    const cutoff = new Date(this.#now().getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const sql = options.hard
      ? `SELECT id FROM tasks WHERE project_id = $projectId AND (status = 'completed' OR deleted = 1) AND last_modified_at < $cutoff`
      : `SELECT id FROM tasks WHERE project_id = $projectId AND status = 'completed' AND deleted = 0 AND last_modified_at < $cutoff`;
    const rows = this.#database
      .query<{ id: string }, QueryBindings>(sql)
      .all({ cutoff, projectId: this.#projectId });
    return { wouldDelete: rows.map((row) => row.id) };
  }

  private checkOrphanPreconditions(
    current: { status: TaskStatus; branch: string | null; session: string | null; deleted: number },
    expected: RecoverOrphanInput,
  ): boolean {
    const branchMatch =
      current.branch === expected.previousBranch ||
      (current.branch === null && expected.previousBranch === null);
    const sessionMatch =
      current.session === expected.previousSession ||
      (current.session === null && expected.previousSession === null);
    return current.status === 'in-progress' && current.deleted === 0 && branchMatch && sessionMatch;
  }

  /** Atomically demotes an orphaned in-progress task back to ready. Guards against stale state. */
  recoverOrphan(id: TaskIdentifier, expected: RecoverOrphanInput): RecoverOrphanResult {
    type StateRow = {
      status: TaskStatus;
      branch: string | null;
      session: string | null;
      deleted: number;
    };
    let outcome: RecoverOrphanResult | null = null;

    const transaction = this.#database.transaction(() => {
      const current = this.#database
        .query<
          StateRow,
          QueryBindings
        >('SELECT status, branch, session, deleted FROM tasks WHERE id = $id AND project_id = $projectId')
        .get({ id, projectId: this.#projectId });

      if (!current) {
        outcome = {
          outcome: 'stale-state',
          actual: { status: 'ready', branch: null, session: null, deleted: false },
        };
        return;
      }

      if (!this.checkOrphanPreconditions(current, expected)) {
        outcome = {
          outcome: 'stale-state',
          actual: {
            status: current.status,
            branch: current.branch,
            session: current.session,
            deleted: current.deleted === 1,
          },
        };
        return;
      }

      const now = this.#now().toISOString();
      const progressId = crypto.randomUUID();
      const previousBranchStr = expected.previousBranch ?? 'none';
      const previousSessionStr = expected.previousSession ?? 'none';
      const message = `[cleanup] orphan recovered: status=in-progress→ready; branch=${previousBranchStr}; session=${previousSessionStr}; reason=${expected.reason}`;

      this.#database
        .query<
          unknown,
          QueryBindings
        >(`UPDATE tasks SET status = 'ready', branch = NULL, session = NULL, last_modified_at = $now WHERE id = $id AND project_id = $projectId`)
        .run({ id, now, projectId: this.#projectId });

      this.#database
        .query<unknown, QueryBindings>(
          `INSERT INTO task_progress (id, task_id, message, created_at, provider, session, event, tool, cwd, transcript_path, commit_sha)
           VALUES ($id, $taskId, $message, $createdAt, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        )
        .run({ id: progressId, taskId: id, message, createdAt: now });

      outcome = {
        outcome: 'applied',
        task: this.requireTask(id),
        progress: this.requireProgress(progressId),
      };
    });

    transaction();
    if (outcome === null)
      throw new ScrumlordError(
        'unexpected_error',
        'recoverOrphan: transaction produced no outcome',
      );
    return outcome;
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

  addBlocker(id: TaskIdentifier, blockedBy: TaskReference): Task {
    this.ensureTaskExists(id);
    const blockerId = taskIdFrom(blockedBy);
    const now = this.#now().toISOString();
    this.insertBlocker(id, blockerId);
    this.touchAt(id, now);
    this.touchAt(blockerId, now);
    return this.requireTask(id);
  }

  removeBlocker(id: TaskIdentifier, blockedBy: TaskReference): Task {
    this.ensureTaskExists(id);
    const blockerId = taskIdFrom(blockedBy);
    const now = this.#now().toISOString();
    this.#database
      .query<
        unknown,
        QueryBindings
      >('DELETE FROM task_dependencies WHERE task_id = $id AND blocked_by_task_id = $blockedBy')
      .run({ id, blockedBy: blockerId });
    this.touchAt(id, now);
    this.touchAt(blockerId, now);
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
       WHERE project_id = $projectId AND provider = $provider AND session = $session AND deleted = 0
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
            id, task_id, message, created_at, provider, session,
            event, tool, cwd, transcript_path, commit_sha
          ) VALUES (
            $id, $taskId, $message, $createdAt, $provider, $session,
            $event, $tool, $cwd, $transcriptPath, $commitSha
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

  allIds(): string[] {
    return this.#database
      .query<{ id: string }, QueryBindings>(
        `SELECT id FROM tasks WHERE project_id = $projectId AND deleted = 0 ORDER BY id`,
      )
      .all({ projectId: this.#projectId })
      .map((row) => row.id);
  }

  allTags(): string[] {
    return this.#database
      .query<{ tag: string }, QueryBindings>(
        `SELECT DISTINCT tag FROM task_tags
         INNER JOIN tasks ON tasks.id = task_tags.task_id
         WHERE tasks.project_id = $projectId AND tasks.deleted = 0
         ORDER BY tag`,
      )
      .all({ projectId: this.#projectId })
      .map((row) => row.tag)
      .filter((tag) => !tag.includes('\n'));
  }

  close(): void {
    this.#database.close(false);
  }

  /**
   * Runs a task-rooted SELECT and hydrates the rows. The store's `project_id`
   * is bound automatically as `$projectId`; every task-rooted query must
   * reference it in its WHERE clause so results never leak across projects.
   */
  private selectTasks(sql: string, bindings: QueryBindings = {}): Task[] {
    return this.#database
      .query<TaskRow, QueryBindings>(sql)
      .all({ projectId: this.#projectId, ...bindings })
      .map((row) => this.hydrate(row));
  }

  private hydrate(row: TaskRow): Task {
    return hydrateTask(row, {
      tags: this.tagValues(row.id),
      blockedBy: this.blockerValues(
        `SELECT blocker.id AS id, blocker.status AS status
         FROM task_dependencies
         JOIN tasks AS blocker ON blocker.id = task_dependencies.blocked_by_task_id
         WHERE task_dependencies.task_id = $id AND blocker.deleted = 0
         ORDER BY blocker.id ASC`,
        row.id,
      ),
      blocking: this.blockerValues(
        `SELECT dependent.id AS id, dependent.status AS status
         FROM task_dependencies
         JOIN tasks AS dependent ON dependent.id = task_dependencies.task_id
         WHERE task_dependencies.blocked_by_task_id = $id AND dependent.deleted = 0
         ORDER BY dependent.id ASC`,
        row.id,
      ),
    });
  }

  private tagValues(id: string): string[] {
    return this.#database
      .query<{ tag: string }, QueryBindings>(
        'SELECT tag FROM task_tags WHERE task_id = $id ORDER BY tag ASC',
      )
      .all({ id })
      .map((row) => row.tag);
  }

  private blockerValues(sql: string, id: string): TaskBlocker[] {
    return this.#database
      .query<{ id: string; status: TaskStatus }, QueryBindings>(sql)
      .all({ id })
      .map((row) => ({ id: row.id, status: row.status }));
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

  private insertBlocker(id: TaskIdentifier, blockedBy: TaskIdentifier): void {
    if (id === blockedBy)
      throw new ScrumlordError('invalid_dependency', 'A task cannot block itself.');
    this.ensureTaskExists(blockedBy);
    if (hasBlockerPath(this.#database, blockedBy, id, this.#projectId)) {
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
      .query(
        'UPDATE tasks SET last_modified_at = $lastModifiedAt WHERE id = $id AND project_id = $projectId',
      )
      .run({ id, lastModifiedAt, projectId: this.#projectId });
  }
}
