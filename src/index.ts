import * as agentProvidersModule from './agent-providers.js';
import * as agentHookModule from './agent-hook.js';
import * as agentHooksModule from './agent-hooks.js';
import * as agentCommandModule from './cli-agent-commands.js';
import * as commandRunnerModule from './command-runner.js';
import * as colorModule from './color.js';
import * as currentBranchTaskModule from './current-branch-task.js';
import * as databaseOpenModule from './database-open.js';
import * as errorsModule from './errors.js';
import * as gitHooksModule from './git-hooks.js';
import * as gitStatusModule from './git-status.js';
import * as githubModule from './github.js';
import * as githubPollModule from './github-poll.js';
import * as helpModule from './help.js';
import * as initModule from './init.js';
import * as mcpServerModule from './mcp-server.js';
import * as rootResolutionModule from './root-resolution.js';
import * as setupModule from './setup.js';
import * as skillsModule from './skills.js';
import * as subagentsModule from './subagents.js';
import * as taskCommandsModule from './task-commands.js';
import * as taskQueriesModule from './task-queries.js';
import * as tasksOverviewModule from './tasks-overview.js';

export const absoluteTaskPlanPath = agentProvidersModule.absoluteTaskPlanPath;
export const addTaskBlocker = taskCommandsModule.addTaskBlocker;
export const addTaskProgress = taskCommandsModule.addTaskProgress;
export const addTaskTag = taskCommandsModule.addTaskTag;
export const agentProviders = agentProvidersModule.agentProviders;
export const availableTasks = taskCommandsModule.availableTasks;
export const blockedTasks = taskCommandsModule.blockedTasks;
export const buildSetupInvocation = agentProvidersModule.buildSetupInvocation;
export const buildTaskResumeInvocation = agentProvidersModule.buildTaskResumeInvocation;
export const buildTaskStartInvocation = agentProvidersModule.buildTaskStartInvocation;
export const checksForPullRequest = githubModule.checksForPullRequest;
export const cleanupTasks = taskCommandsModule.cleanupTasks;
export const clearTaskBranch = taskCommandsModule.clearTaskBranch;
export const clearTaskPlan = taskCommandsModule.clearTaskPlan;
export const clearTaskSession = taskCommandsModule.clearTaskSession;
export const completedTasks = taskCommandsModule.completedTasks;
export const continuousIntegrationStatus = githubModule.continuousIntegrationStatus;
export const createTask = taskCommandsModule.createTask;
export const createScrumlordMcpServer = mcpServerModule.createScrumlordMcpServer;
export const createTaskStore = databaseOpenModule.createTaskStore;
export const createTheme = colorModule.createTheme;
export const currentGitBranch = gitStatusModule.currentGitBranch;
export const currentBranchTask = currentBranchTaskModule.currentBranchTask;
export const currentPullRequest = githubModule.currentPullRequest;
export const defaultTaskPlanPath = agentProvidersModule.defaultTaskPlanPath;
export const deleteTask = taskCommandsModule.deleteTask;
export const getAgentProvider = agentProvidersModule.getAgentProvider;
export const getTask = taskCommandsModule.getTask;
export const helpTopics = helpModule.helpTopics;
export const initializeProject = initModule.initializeProject;
export const launchProviderInvocation = setupModule.launchProviderInvocation;
export const listTasks = taskCommandsModule.listTasks;
export const next = taskQueriesModule.next;
export const nextTask = taskQueriesModule.nextTask;
export const openPullRequests = githubModule.openPullRequests;
export const persistedTaskSession = taskCommandsModule.persistedTaskSession;
export const pullRequestPollStatus = githubPollModule.pullRequestPollStatus;
export const pullRequestStatus = githubModule.pullRequestStatus;
export const pullRequestUrl = githubModule.pullRequestUrl;
export const remaining = taskQueriesModule.remaining;
export const remainingTasks = taskQueriesModule.remainingTasks;
export const removeTaskBlocker = taskCommandsModule.removeTaskBlocker;
export const removeTaskTag = taskCommandsModule.removeTaskTag;
export const renderHelp = helpModule.renderHelp;
export const repositoryName = githubModule.repositoryName;
export const repositoryUrl = githubModule.repositoryUrl;
export const resolveProjectRoot = rootResolutionModule.resolveProjectRoot;
export const resolveTaskSession = agentProvidersModule.resolveTaskSession;
export const reviewCommentsForPullRequest = githubModule.reviewCommentsForPullRequest;
export const resumeTask = agentCommandModule.resumeTask;
export const runAgentHook = agentHookModule.runAgentHook;
export const runCommand = commandRunnerModule.runCommand;
export const runScrumlordMcpServer = mcpServerModule.runScrumlordMcpServer;
export const ScrumlordError = errorsModule.ScrumlordError;
export const setTaskBranch = taskCommandsModule.setTaskBranch;
export const setTaskPlan = taskCommandsModule.setTaskPlan;
export const setTaskSession = taskCommandsModule.setTaskSession;
export const setTaskStatus = taskCommandsModule.setTaskStatus;
export const setupAgentHooks = agentHooksModule.setupAgentHooks;
export const setupGitHooks = gitHooksModule.setupGitHooks;
export const setupProject = setupModule.setupProject;
export const setupSelectionFromFlags = setupModule.setupSelectionFromFlags;
export const setupSelectionFromInput = setupModule.setupSelectionFromInput;
export const setupSkills = skillsModule.setupSkills;
export const setupStatus = setupModule.setupStatus;
export const setupSubagents = subagentsModule.setupSubagents;
export const skillTargets = skillsModule.skillTargets;
export const startTask = agentCommandModule.startTask;
export const syncGitStatus = gitStatusModule.syncGitStatus;
export const tasksBlockedBy = taskCommandsModule.tasksBlockedBy;
export const tasksBlocking = taskCommandsModule.tasksBlocking;
export const tasksOverview = tasksOverviewModule.tasksOverview;
export const taskProgress = taskCommandsModule.taskProgress;
export const taskTags = taskCommandsModule.taskTags;
export const tasksWithAllTags = taskCommandsModule.tasksWithAllTags;
export const tasksWithAnyTags = taskCommandsModule.tasksWithAnyTags;
export const tasksWithBranch = taskCommandsModule.tasksWithBranch;
export const tasksWithPriority = taskCommandsModule.tasksWithPriority;
export const tasksWithStatus = taskCommandsModule.tasksWithStatus;
export const tasksWithSession = taskCommandsModule.tasksWithSession;
export const tasksWithTag = taskCommandsModule.tasksWithTag;
export const unresolvedReviewComments = githubModule.unresolvedReviewComments;
export const updateTask = taskCommandsModule.updateTask;
export const worktreeForBranch = gitStatusModule.worktreeForBranch;
export const withTaskStore = mcpServerModule.withTaskStore;

export type {
  AgentCliProvider,
  AgentInvocation,
  AgentResumeInvocationContext,
  AgentSetupInvocationContext,
  AgentSessionPathOptions,
  AgentStartInvocationContext,
  ResolveTaskSessionOptions,
} from './agent-providers.js';
export type { AgentHookOptions, AgentHookResult } from './agent-hook.js';
export type { SetupAgentHooksOptions, SetupAgentHooksResult } from './agent-hooks.js';
export type { TaskAgentCommandOptions, TaskAgentCommandResult } from './cli-agent-commands.js';
export type { CommandResult, CommandRunner } from './command-runner.js';
export type { ColorMode, Theme } from './color.js';
export type { CurrentBranchTaskOptions } from './current-branch-task.js';
export type { CreateTaskStoreOptions } from './database-open.js';
export type ScrumlordError = InstanceType<typeof errorsModule.ScrumlordError>;
export type { SetupGitHooksOptions, SetupGitHooksResult } from './git-hooks.js';
export type {
  GitHubOptions,
  MergeableState,
  MergeStateStatus,
  PullRequest,
  PullRequestCheck,
  PullRequestCheckConclusion,
  PullRequestCheckReport,
  PullRequestStatusReport,
  ReviewComment,
} from './github.js';
export type { PullRequestPollOptions, PullRequestPollReport } from './github-poll.js';
export type {
  SyncGitStatusOptions,
  SyncGitStatusResult,
  SynchronizedPullRequestState,
} from './git-status.js';
export type { InitializeProjectOptions, InitializeProjectResult } from './init.js';
export type { ScrumlordMcpServerOptions } from './mcp-server.js';
export type {
  SetupProjectOptions,
  SetupProjectResult,
  SetupSelection,
  SetupStatus,
  SetupStatusProvider,
  SetupStatusSkill,
} from './setup.js';
export type { SkillTarget, WrittenSkill } from './skills.js';
export type {
  SetupSubagentsOptions,
  SetupSubagentsResult,
  SubagentScope,
  WhichExecutable,
  WrittenSubagent,
  WrittenSubagentSkill,
} from './subagents.js';
export type {
  CleanupTasksResult,
  CountListTasksOptions,
  CountTaskListingOptions,
  ListTasksOptions,
  TaskListingOptions,
  TaskPlanFilter,
} from './task-commands.js';
export type { PullRequestOverviewItem } from './tasks-overview.js';
export type {
  AddTaskProgressInput,
  AgentProvider,
  CreateTaskInput,
  DateInput,
  PersistedTaskSession,
  Task,
  TaskIdentifier,
  TaskProgress,
  TaskPriority,
  TaskReference,
  TaskSession,
  TaskStatus,
  TaskStore,
  UpdateTaskInput,
} from './types.js';
