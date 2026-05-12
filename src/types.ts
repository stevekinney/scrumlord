export const taskStatuses = ['draft', 'ready', 'in-progress', 'in-review', 'completed'] as const;
export type TaskStatus = (typeof taskStatuses)[number];

export const taskPriorities = [1, 2, 3] as const;
export type TaskPriority = (typeof taskPriorities)[number];

export const agentProviderNames = ['claude', 'codex'] as const;
export type AgentProvider = (typeof agentProviderNames)[number];

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
  planPath: string | null;
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
};

export type AddTaskProgressInput = {
  id?: string;
  message: string;
  provider?: AgentProvider | null;
  session?: string | null;
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
  parent: TaskIdentifier | null;
  subtasks: TaskIdentifier[];
  blockedBy: TaskIdentifier[];
  blocking: TaskIdentifier[];
  lastModifiedAt: string;
  archived: boolean;
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
  parent?: TaskReference | null;
  blockedBy?: TaskReference[];
};

export type UpdateTaskInput = Partial<
  Pick<
    Task,
    'title' | 'status' | 'description' | 'archived' | 'deleted' | 'plan' | 'provider' | 'session'
  >
> & {
  priority?: TaskPriority;
  startDate?: DateInput;
  dueDate?: DateInput;
  branch?: string | null;
  parent?: TaskReference | null;
};

export type DateInput = Date | string | null;

export type TaskStore = {
  readonly projectRoot: string;
  readonly databasePath: string;
  create(input: CreateTaskInput): Task;
  update(id: TaskIdentifier, input: UpdateTaskInput): Task;
  delete(id: TaskIdentifier): Task;
  archive(id: TaskIdentifier): Task;
  restore(id: TaskIdentifier): Task;
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
  remaining(): number;
  cleanup(days: number): { deleted: number };
  addTag(id: TaskIdentifier, tag: string): Task;
  removeTag(id: TaskIdentifier, tag: string): Task;
  setParent(id: TaskIdentifier, parent: TaskReference): Task;
  clearParent(id: TaskIdentifier): Task;
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
