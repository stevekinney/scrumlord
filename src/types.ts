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
  blockedBy: TaskIdentifier[];
  blocking: TaskIdentifier[];
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
  close(): void;
};
