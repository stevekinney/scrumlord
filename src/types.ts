import type { RecoverOrphanInput, RecoverOrphanResult } from './orphan-recovery.js';

export const taskStatuses = ['draft', 'ready', 'in-progress', 'in-review', 'completed'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const taskPriorities = [1, 2, 3] as const;
export type TaskPriority = (typeof taskPriorities)[number];

export const agentProviderNames = ['claude', 'codex'] as const;
export type AgentProvider = (typeof agentProviderNames)[number];

export const progressEvents = [
  'session_start',
  'session_stop',
  'session_end',
  'tool_failed',
  'commit',
] as const;
export type ProgressEvent = (typeof progressEvents)[number];

export type TaskIdentifier = string;

/**
 * A task referenced as a blocker or dependent. Includes the referenced task's
 * current status so callers can tell whether the dependency is still
 * outstanding without doing a follow-up lookup.
 */
export type TaskBlocker = {
  id: TaskIdentifier;
  status: TaskStatus;
};

export type PersistedTaskSession = {
  taskId: TaskIdentifier;
  provider: AgentProvider | null;
  session: string | null;
  branch: string | null;
  plan: string | null;
};

export type TaskSession = PersistedTaskSession & {
  worktree: string | null;
  sessionPath: string | null;
  warnings: string[];
};

export type TaskProgress = {
  id: string;
  taskId: TaskIdentifier;
  message: string;
  createdAt: string;
  provider: AgentProvider | null;
  session: string | null;
  event: ProgressEvent | null;
  tool: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  commitSha: string | null;
};

export type AddTaskProgressInput = {
  id?: string;
  message: string;
  provider?: AgentProvider | null;
  session?: string | null;
  event?: ProgressEvent | null;
  tool?: string | null;
  cwd?: string | null;
  transcriptPath?: string | null;
  commitSha?: string | null;
};

export type Task = {
  id: TaskIdentifier;
  title: string;
  status: TaskStatus;
  description: string;
  priority: TaskPriority;
  createdAt: string;
  startDate: string | null;
  dueDate: string | null;
  branch: string | null;
  plan: string | null;
  provider: AgentProvider | null;
  session: string | null;
  tags: string[];
  blockedBy: TaskBlocker[];
  blocking: TaskBlocker[];
  /**
   * True when this task has at least one blocker that is not yet completed.
   * False when there are no blockers, or every blocker has been completed.
   * Computed at hydration time from `blockedBy`.
   */
  blocked: boolean;
  lastModifiedAt: string;
  deleted: boolean;
};

export type TaskReference = Task | TaskIdentifier;

export type CreateTaskInput = {
  id?: TaskIdentifier;
  title: string;
  status?: TaskStatus;
  description?: string;
  priority?: TaskPriority;
  startDate?: DateInput;
  dueDate?: DateInput;
  branch?: string | null;
  plan?: string | null;
  provider?: AgentProvider | null;
  session?: string | null;
  tags?: string[];
  blockedBy?: TaskReference[];
};

export type UpdateTaskInput = Partial<
  Pick<Task, 'title' | 'status' | 'description' | 'deleted' | 'plan' | 'provider' | 'session'>
> & {
  priority?: TaskPriority;
  startDate?: DateInput;
  dueDate?: DateInput;
  branch?: string | null;
};

export type DateInput = Date | string | null;

/** Options for `TaskStore.claimNext`. */
export type ClaimNextOptions = {
  /** Pipeline run id recorded in the `pipeline:phase=claim` marker for ownership checks. */
  runId: string;
};

/**
 * Predicate evaluated against the current row inside `conditionalUpdate`'s
 * transaction. The update only proceeds when every supplied field matches.
 */
export type ConditionalUpdatePredicate = {
  ifStatus?: TaskStatus;
  ifBranch?: string | null;
  /** Match the run id parsed from the latest `pipeline:phase=...;run=<id>;...` marker. */
  ifRunId?: string;
};

/** Options for `TaskStore.cleanup`. */
export type CleanupOptions = {
  /** When true, physically delete rows (with FK cascades) instead of soft-deleting. */
  hard?: boolean;
};

/** Options for `TaskStore.delete`. */
export type DeleteOptions = {
  /** When true, physically delete the row (with FK cascades) instead of soft-deleting. */
  hard?: boolean;
};

export type TaskStore = {
  readonly projectRoot: string;
  readonly databasePath: string;
  /**
   * Canonical git common dir of the resolved project, or `null` when the
   * project is unresolved or has no filesystem anchor. Used to guard
   * filesystem/git-dependent commands against a `--project` selector that
   * points at a different working tree.
   */
  readonly projectGitCommonDir: string | null;
  /**
   * False when no project could be resolved (no git repository, or a non-git
   * directory). Read commands then return empty results; the CLI surfaces a
   * notice so callers can distinguish "unresolved project" from "no tasks".
   */
  readonly projectResolved: boolean;
  create(input: CreateTaskInput): Task;
  update(id: TaskIdentifier, input: UpdateTaskInput): Task;
  delete(id: TaskIdentifier, options?: DeleteOptions): Task | null;
  getTask(id: TaskIdentifier): Task | null;
  list(options?: { includeInactive?: boolean }): Task[];
  available(): Task[];
  blocked(): Task[];
  completed(): Task[];
  withTag(tag: string): Task[];
  withAllTags(...tags: string[]): Task[];
  withAnyTag(...tags: string[]): Task[];
  withBranch(branch: string): Task[];
  blockedBy(taskOrId: TaskReference): Task[];
  blocking(taskOrId: TaskReference): Task[];
  withPriority(priority: TaskPriority): Task[];
  withStatus(status: TaskStatus): Task[];
  next(): Task | null;
  claimNext(options: ClaimNextOptions): Task | null;
  listClaimCandidates(limit: number, excludeIds?: Set<TaskIdentifier>): Task[];
  conditionalUpdate(
    id: TaskIdentifier,
    patch: UpdateTaskInput,
    predicate: ConditionalUpdatePredicate,
  ): Task | null;
  remaining(): number;
  /**
   * Returns a count of active (non-deleted) tasks grouped by status. Used by
   * the pipeline to render a "ready-queue breakdown" line when the drain
   * finds nothing to claim, so the operator can see whether the queue is
   * empty because everything is blocked, in-progress, etc.
   */
  summarizeReadyQueue(): {
    draft: number;
    ready: number;
    inProgress: number;
    inReview: number;
    completed: number;
    blocked: number;
  };
  cleanup(days: number, options?: CleanupOptions): { deleted: number };
  previewCleanup(days: number, options?: CleanupOptions): { wouldDelete: TaskIdentifier[] };
  inProgress(): Task[];
  recoverOrphan(id: TaskIdentifier, expected: RecoverOrphanInput): RecoverOrphanResult;
  countInProgress(): number;
  countBranched(): number;
  addTag(id: TaskIdentifier, tag: string): Task;
  removeTag(id: TaskIdentifier, tag: string): Task;
  addBlocker(id: TaskIdentifier, blockedBy: TaskReference): Task;
  removeBlocker(id: TaskIdentifier, blockedBy: TaskReference): Task;
  setPlan(id: TaskIdentifier, plan: string | null): Task;
  setSession(id: TaskIdentifier, provider: AgentProvider, session: string | null): Task;
  withSession(provider: AgentProvider, session: string): Task[];
  taskSession(id: TaskIdentifier): PersistedTaskSession;
  progress(id: TaskIdentifier): TaskProgress[];
  addProgress(id: TaskIdentifier, input: AddTaskProgressInput): TaskProgress;
  /** Returns all non-deleted task IDs, sorted ascending. Used by shell completions. */
  allIds(): string[];
  /** Returns all distinct tag names across non-deleted tasks, sorted ascending. Tags containing newlines are excluded. Used by shell completions. */
  allTags(): string[];
  /** Like {@link allTags}, but spanning every project in the shared database rather than just the current one. Same sort, dedup, and newline filtering. */
  allTagsAcrossProjects(): string[];
  close(): void;
};
