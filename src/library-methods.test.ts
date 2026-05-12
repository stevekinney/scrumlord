import { describe, expect, it } from 'bun:test';
import {
  absoluteTaskPlanPath,
  addTaskBlocker,
  addTaskTag,
  agentProviders,
  archiveTask,
  availableTasks,
  blockedTasks,
  buildTaskResumeInvocation,
  buildSetupInvocation,
  buildTaskStartInvocation,
  checksForPullRequest,
  cleanupTasks,
  clearTaskParent,
  completedTasks,
  continuousIntegrationStatus,
  createScrumlordMcpServer,
  createTask,
  createTaskStore,
  createTheme,
  currentGitBranch,
  currentPullRequest,
  defaultTaskPlanPath,
  deleteTask,
  getAgentProvider,
  getTask,
  helpTopics,
  initializeProject,
  launchProviderInvocation,
  listTasks,
  next,
  nextTask,
  openPullRequests,
  persistedTaskSession,
  pullRequestStatus,
  pullRequestUrl,
  repositoryName,
  repositoryUrl,
  remaining,
  remainingTasks,
  removeTaskBlocker,
  removeTaskTag,
  renderHelp,
  resolveTaskSession,
  restoreTask,
  resumeTask,
  reviewCommentsForPullRequest,
  runAgentHook,
  runCommand,
  runScrumlordMcpServer,
  ScrumlordError,
  setTaskParent,
  setTaskPlan,
  setTaskSession,
  setupAgentHooks,
  setupGitHooks,
  setupProject,
  setupSelectionFromFlags,
  setupSelectionFromInput,
  setupSkills,
  setupStatus,
  setupSubagents,
  skillTargets,
  startTask,
  syncGitStatus,
  tasksBlockedBy,
  tasksBlocking,
  tasksOverview,
  tasksWithAllTags,
  tasksWithAnyTags,
  tasksWithBranch,
  tasksWithPriority,
  tasksWithSession,
  tasksWithTag,
  unresolvedReviewComments,
  updateTask,
  withTaskStore,
  worktreeForBranch,
} from './index';
import { emptyProgressStoreMethods } from './test-progress-store-methods';
import type {
  AgentCliProvider,
  AgentHookOptions,
  AgentHookResult,
  AgentInvocation,
  AgentProvider,
  AgentResumeInvocationContext,
  AgentSetupInvocationContext,
  AgentSessionPathOptions,
  AgentStartInvocationContext,
  CleanupTasksResult,
  ColorMode,
  CommandResult,
  CommandRunner,
  CreateTaskInput,
  CreateTaskStoreOptions,
  DateInput,
  GitHubOptions,
  InitializeProjectOptions,
  InitializeProjectResult,
  PersistedTaskSession,
  PullRequest,
  PullRequestCheck,
  PullRequestCheckConclusion,
  PullRequestCheckReport,
  PullRequestOverviewItem,
  PullRequestStatusReport,
  ResolveTaskSessionOptions,
  ReviewComment,
  ScrumlordMcpServerOptions,
  ScrumlordError as ScrumlordErrorInstance,
  SetupAgentHooksResult,
  SetupGitHooksOptions,
  SetupGitHooksResult,
  SetupProjectOptions,
  SetupProjectResult,
  SetupSelection,
  SetupStatus,
  SetupStatusProvider,
  SetupStatusSkill,
  SetupSubagentsOptions,
  SetupSubagentsResult,
  SkillTarget,
  SubagentScope,
  SyncGitStatusOptions,
  SyncGitStatusResult,
  SynchronizedPullRequestState,
  Task,
  TaskAgentCommandOptions,
  TaskAgentCommandResult,
  TaskIdentifier,
  TaskPriority,
  TaskReference,
  TaskSession,
  TaskStatus,
  TaskStore,
  Theme,
  UpdateTaskInput,
  WrittenSkill,
  WhichExecutable,
  WrittenSubagent,
  WrittenSubagentSkill,
} from './index';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'ready',
  description: '',
  priority: 1,
  createdAt: '2026-05-11T00:00:00.000Z',
  startDate: null,
  dueDate: null,
  branch: null,
  plan: null,
  provider: null,
  session: null,
  tags: [],
  parent: null,
  subtasks: [],
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  archived: false,
  deleted: false,
  ...overrides,
});

const referenceId = (reference: TaskReference): string => {
  return typeof reference === 'string' ? reference : reference.id;
};

const firstTask = (tasks: Task[]): Task => {
  const [first] = tasks;
  if (!first) throw new Error('Expected at least one task.');
  return first;
};

type PublicCompanionTypes = {
  agentCliProvider: AgentCliProvider;
  agentHookOptions: AgentHookOptions;
  agentHookResult: AgentHookResult;
  agentInvocation: AgentInvocation;
  agentProvider: AgentProvider;
  agentResumeInvocationContext: AgentResumeInvocationContext;
  agentSetupInvocationContext: AgentSetupInvocationContext;
  agentSessionPathOptions: AgentSessionPathOptions;
  agentStartInvocationContext: AgentStartInvocationContext;
  cleanupTasksResult: CleanupTasksResult;
  colorMode: ColorMode;
  commandResult: CommandResult;
  commandRunner: CommandRunner;
  createTaskInput: CreateTaskInput;
  createTaskStoreOptions: CreateTaskStoreOptions;
  dateInput: DateInput;
  gitHubOptions: GitHubOptions;
  initializeProjectOptions: InitializeProjectOptions;
  initializeProjectResult: InitializeProjectResult;
  persistedTaskSession: PersistedTaskSession;
  pullRequest: PullRequest;
  pullRequestCheck: PullRequestCheck;
  pullRequestCheckConclusion: PullRequestCheckConclusion;
  pullRequestCheckReport: PullRequestCheckReport;
  pullRequestOverviewItem: PullRequestOverviewItem;
  pullRequestStatusReport: PullRequestStatusReport;
  resolveTaskSessionOptions: ResolveTaskSessionOptions;
  reviewComment: ReviewComment;
  scrumlordMcpServerOptions: ScrumlordMcpServerOptions;
  scrumlordError: ScrumlordErrorInstance;
  setupAgentHooksResult: SetupAgentHooksResult;
  setupGitHooksOptions: SetupGitHooksOptions;
  setupGitHooksResult: SetupGitHooksResult;
  setupProjectOptions: SetupProjectOptions;
  setupProjectResult: SetupProjectResult;
  setupSelection: SetupSelection;
  setupStatus: SetupStatus;
  setupStatusProvider: SetupStatusProvider;
  setupStatusSkill: SetupStatusSkill;
  setupSubagentsOptions: SetupSubagentsOptions;
  setupSubagentsResult: SetupSubagentsResult;
  skillTarget: SkillTarget;
  subagentScope: SubagentScope;
  syncGitStatusOptions: SyncGitStatusOptions;
  syncGitStatusResult: SyncGitStatusResult;
  synchronizedPullRequestState: SynchronizedPullRequestState;
  taskAgentCommandOptions: TaskAgentCommandOptions;
  taskAgentCommandResult: TaskAgentCommandResult;
  taskIdentifier: TaskIdentifier;
  taskPriority: TaskPriority;
  taskReference: TaskReference;
  taskSession: TaskSession;
  taskStatus: TaskStatus;
  taskStore: TaskStore;
  theme: Theme;
  updateTaskInput: UpdateTaskInput;
  writtenSkill: WrittenSkill;
  whichExecutable: WhichExecutable;
  writtenSubagent: WrittenSubagent;
  writtenSubagentSkill: WrittenSubagentSkill;
};

const acceptsPublicCompanionTypes = (_value: Partial<PublicCompanionTypes>): boolean => true;

const fakeStore = (calls: string[]): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  create(input) {
    calls.push(`create:${input.title}`);
    return task('created', { title: input.title });
  },
  update(id, input) {
    calls.push(`update:${id}:${input.title ?? ''}`);
    return task(id, input);
  },
  delete(id) {
    calls.push(`delete:${id}`);
    return task(id, { deleted: true });
  },
  archive(id) {
    calls.push(`archive:${id}`);
    return task(id, { archived: true });
  },
  restore(id) {
    calls.push(`restore:${id}`);
    return task(id);
  },
  getTask(id) {
    calls.push(`getTask:${id}`);
    return task(id);
  },
  list(options) {
    calls.push(`list:${options?.includeInactive ? 'all' : 'active'}`);
    return [task('list')];
  },
  available() {
    calls.push('available');
    return [task('available')];
  },
  blocked() {
    calls.push('blocked');
    return [task('blocked')];
  },
  completed() {
    calls.push('completed');
    return [task('completed')];
  },
  withTag(tag) {
    calls.push(`withTag:${tag}`);
    return [task('with-tag')];
  },
  withAllTags(...tags) {
    calls.push(`withAllTags:${tags.join(',')}`);
    return [task('with-all-tags')];
  },
  withAnyTag(...tags) {
    calls.push(`withAnyTag:${tags.join(',')}`);
    return [task('with-any-tags')];
  },
  withBranch(branch) {
    calls.push(`withBranch:${branch}`);
    return [task('with-branch')];
  },
  blockedBy(taskOrId) {
    calls.push(`blockedBy:${referenceId(taskOrId)}`);
    return [task('blocked-by')];
  },
  blocking(taskOrId) {
    calls.push(`blocking:${referenceId(taskOrId)}`);
    return [task('blocking')];
  },
  withPriority(priority) {
    calls.push(`withPriority:${priority}`);
    return [task('priority')];
  },
  next() {
    calls.push('next');
    return task('next');
  },
  remaining() {
    calls.push('remaining');
    return 3;
  },
  cleanup(days) {
    calls.push(`cleanup:${days}`);
    return { deleted: days };
  },
  addTag(id, tag) {
    calls.push(`addTag:${id}:${tag}`);
    return task(id, { tags: [tag] });
  },
  removeTag(id, tag) {
    calls.push(`removeTag:${id}:${tag}`);
    return task(id);
  },
  setParent(id, parent) {
    calls.push(`setParent:${id}:${referenceId(parent)}`);
    return task(id, { parent: referenceId(parent) });
  },
  clearParent(id) {
    calls.push(`clearParent:${id}`);
    return task(id);
  },
  addBlocker(id, blockedBy) {
    calls.push(`addBlocker:${id}:${referenceId(blockedBy)}`);
    return task(id);
  },
  removeBlocker(id, blockedBy) {
    calls.push(`removeBlocker:${id}:${referenceId(blockedBy)}`);
    return task(id);
  },
  setPlan(id, plan) {
    calls.push(`setPlan:${id}:${plan ?? ''}`);
    return task(id, { plan });
  },
  setSession(id, provider, session) {
    calls.push(`setSession:${id}:${provider}:${session ?? ''}`);
    return task(id, { provider, session });
  },
  withSession(provider, session) {
    calls.push(`withSession:${provider}:${session}`);
    return [task('with-session', { provider, session })];
  },
  taskSession(id) {
    calls.push(`taskSession:${id}`);
    return {
      taskId: id,
      provider: 'codex',
      session: 'codex-session',
      branch: 'feature/task-graph',
      plan: 'tmp/tasks/task-id/PLAN.md',
    };
  },
  ...emptyProgressStoreMethods,
  close() {
    calls.push('close');
  },
});

describe('library command equivalents', () => {
  it('exports a package-root method for each CLI command family', () => {
    const methods = [
      absoluteTaskPlanPath,
      initializeProject,
      launchProviderInvocation,
      renderHelp,
      createTheme,
      createScrumlordMcpServer,
      createTaskStore,
      availableTasks,
      blockedTasks,
      completedTasks,
      getTask,
      listTasks,
      tasksWithTag,
      tasksWithAllTags,
      tasksWithAnyTags,
      tasksWithBranch,
      tasksBlockedBy,
      tasksBlocking,
      tasksWithPriority,
      next,
      remaining,
      resolveTaskSession,
      createTask,
      updateTask,
      deleteTask,
      archiveTask,
      restoreTask,
      addTaskTag,
      removeTaskTag,
      setTaskParent,
      clearTaskParent,
      addTaskBlocker,
      removeTaskBlocker,
      setTaskPlan,
      setTaskSession,
      cleanupTasks,
      syncGitStatus,
      setupSkills,
      setupGitHooks,
      setupAgentHooks,
      setupProject,
      setupSelectionFromFlags,
      setupSelectionFromInput,
      setupStatus,
      setupSubagents,
      runAgentHook,
      startTask,
      runScrumlordMcpServer,
      resumeTask,
      runCommand,
      withTaskStore,
      currentGitBranch,
      worktreeForBranch,
      currentPullRequest,
      repositoryName,
      repositoryUrl,
      pullRequestUrl,
      pullRequestStatus,
      tasksOverview,
      unresolvedReviewComments,
      continuousIntegrationStatus,
      openPullRequests,
      reviewCommentsForPullRequest,
      checksForPullRequest,
      defaultTaskPlanPath,
      getAgentProvider,
      buildSetupInvocation,
      buildTaskStartInvocation,
      buildTaskResumeInvocation,
    ];

    expect(methods.every((method) => typeof method === 'function')).toBe(true);
    expect(agentProviders).toEqual(['claude', 'codex']);
    expect(skillTargets).toEqual(['codex', 'claude', 'cursor']);
    expect(helpTopics).toContain('next');
    expect(ScrumlordError.name).toBe('ScrumlordError');
    expect(nextTask).toBe(next);
    expect(remainingTasks).toBe(remaining);
  });

  it('exports companion types for root-level functions', () => {
    expect(acceptsPublicCompanionTypes({})).toBe(true);
  });

  it('routes task command helpers through the task store API', () => {
    const calls: string[] = [];
    const store = fakeStore(calls);

    expect(firstTask(availableTasks(store)).id).toBe('available');
    expect(firstTask(blockedTasks(store)).id).toBe('blocked');
    expect(firstTask(completedTasks(store)).id).toBe('completed');
    expect(getTask(store, 'task-id')?.id).toBe('task-id');
    expect(firstTask(listTasks(store)).id).toBe('list');
    expect(firstTask(listTasks(store, { includeInactive: true })).id).toBe('list');
    expect(firstTask(tasksWithTag(store, 'frontend')).id).toBe('with-tag');
    expect(firstTask(tasksWithAllTags(store, 'frontend', 'backend')).id).toBe('with-all-tags');
    expect(firstTask(tasksWithAnyTags(store, 'frontend', 'backend')).id).toBe('with-any-tags');
    expect(firstTask(tasksWithBranch(store, 'feature/task-graph')).id).toBe('with-branch');
    expect(firstTask(tasksBlockedBy(store, 'task-id')).id).toBe('blocked-by');
    expect(firstTask(tasksBlocking(store, 'task-id')).id).toBe('blocking');
    expect(firstTask(tasksWithPriority(store, 3)).id).toBe('priority');
    expect(next(store)?.id).toBe('next');
    expect(remaining(store)).toBe(3);
    expect(createTask(store, { title: 'Created task' }).title).toBe('Created task');
    expect(updateTask(store, 'task-id', { title: 'Updated task' }).title).toBe('Updated task');
    expect(deleteTask(store, 'task-id').deleted).toBe(true);
    expect(archiveTask(store, 'task-id').archived).toBe(true);
    expect(restoreTask(store, 'task-id').id).toBe('task-id');
    expect(addTaskTag(store, 'task-id', 'frontend').tags).toEqual(['frontend']);
    expect(removeTaskTag(store, 'task-id', 'frontend').id).toBe('task-id');
    expect(setTaskParent(store, 'task-id', 'parent-id').parent).toBe('parent-id');
    expect(clearTaskParent(store, 'task-id').id).toBe('task-id');
    expect(addTaskBlocker(store, 'task-id', 'blocker-id').id).toBe('task-id');
    expect(removeTaskBlocker(store, 'task-id', 'blocker-id').id).toBe('task-id');
    expect(setTaskPlan(store, 'task-id', 'tmp/tasks/task-id/PLAN.md').plan).toBe(
      'tmp/tasks/task-id/PLAN.md',
    );
    expect(setTaskSession(store, 'task-id', 'codex', 'session').session).toBe('session');
    expect(firstTask(tasksWithSession(store, 'codex', 'session')).session).toBe('session');
    expect(persistedTaskSession(store, 'task-id').session).toBe('codex-session');
    expect(cleanupTasks(store, 30)).toEqual({ deleted: 30 });

    expect(calls).toContain('available');
    expect(calls).toContain('list:active');
    expect(calls).toContain('list:all');
    expect(calls).toContain('withAllTags:frontend,backend');
    expect(calls).toContain('setSession:task-id:codex:session');
    expect(calls).toContain('cleanup:30');
  });
});
