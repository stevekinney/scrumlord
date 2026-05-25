import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyProgressStoreMethods } from './test-progress-store-methods.js';
import type { Task, TaskReference, TaskStore } from './types.js';

/**
 * Builds a fully-populated {@link Task} for CLI tests. Override only the fields
 * a given assertion cares about.
 */
export const task = (id: string, overrides: Partial<Task> = {}): Task => ({
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
  blocked: false,
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  deleted: false,
  ...overrides,
});

const referenceId = (reference: TaskReference): string => {
  return typeof reference === 'string' ? reference : reference.id;
};

const optionalCall = (condition: boolean, value: string): string[] => {
  return condition ? [value] : [];
};

const updateCallDescriptions = (
  id: string,
  input: Parameters<TaskStore['update']>[1],
): string[] => [
  `update:${id}:${input.title ?? ''}:${input.priority ?? ''}:${input.branch ?? ''}`,
  ...optionalCall(input.status !== undefined, `updateStatus:${id}:${input.status ?? ''}`),
  ...optionalCall('branch' in input && input.branch === null, `clearBranch:${id}`),
  ...optionalCall(
    'provider' in input || 'session' in input,
    `updateSession:${id}:${input.provider ?? ''}:${input.session ?? ''}`,
  ),
];

/**
 * An in-memory {@link TaskStore} that records each invocation as a string in
 * `calls`. The recorded format is the contract CLI tests assert against — e.g.
 * `create:<title>:<status>:<priority>:<branch>:desc=<description>`.
 */
export const fakeStore = (calls: string[]): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  projectGitCommonDir: '/project/.git',
  projectResolved: true,
  create(input) {
    calls.push(
      `create:${input.title}:${input.status}:${input.priority}:${input.branch ?? ''}:desc=${input.description ?? ''}`,
    );
    return task('created');
  },
  update(id, input) {
    calls.push(...updateCallDescriptions(id, input));
    return task(id);
  },
  delete(id, options) {
    calls.push(`delete:${id}${options?.hard ? ':hard' : ''}`);
    return options?.hard ? null : task(id);
  },
  getTask(id) {
    calls.push(`get:${id}`);
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
    return [task('with-any-tag')];
  },
  withBranch(branch) {
    calls.push(`withBranch:${branch}`);
    return [task('with-branch')];
  },
  withSession(provider, session) {
    calls.push(`withSession:${provider}:${session}`);
    return [task('with-session')];
  },
  blockedBy(id) {
    calls.push(`blockedBy:${referenceId(id)}`);
    return [task('blocked-by')];
  },
  blocking(id) {
    calls.push(`blocking:${referenceId(id)}`);
    return [task('blocking')];
  },
  withPriority(priority) {
    calls.push(`withPriority:${priority}`);
    return [task('priority')];
  },
  withStatus(status) {
    calls.push(`withStatus:${status}`);
    return [task('status')];
  },
  next() {
    calls.push('next');
    return task('next');
  },
  claimNext(options) {
    calls.push(`claimNext:${options.runId}`);
    return task('claim-next');
  },
  listClaimCandidates(limit) {
    calls.push(`listClaimCandidates:${limit}`);
    return [task('claim-candidate')];
  },
  conditionalUpdate(id, patch) {
    calls.push(...updateCallDescriptions(id, patch));
    return task(id);
  },
  summarizeReadyQueue() {
    calls.push('summarizeReadyQueue');
    return { draft: 0, ready: 0, inProgress: 0, inReview: 0, completed: 0, blocked: 0 };
  },
  remaining() {
    calls.push('remaining');
    return 3;
  },
  cleanup(days, options) {
    calls.push(`cleanup:${days}${options?.hard ? ':hard' : ''}`);
    return { deleted: days ?? 0 };
  },
  previewCleanup(days) {
    calls.push(`previewCleanup:${days}`);
    return { wouldDelete: [] };
  },
  inProgress() {
    calls.push('inProgress');
    return [];
  },
  recoverOrphan() {
    calls.push('recoverOrphan');
    return {
      outcome: 'stale-state',
      actual: { status: 'in-progress', branch: null, session: null, deleted: false },
    } as const;
  },
  countInProgress() {
    calls.push('countInProgress');
    return 0;
  },
  countBranched() {
    calls.push('countBranched');
    return 0;
  },
  addTag(id, tag) {
    calls.push(`addTag:${id}:${tag}`);
    return task(id);
  },
  removeTag(id, tag) {
    calls.push(`removeTag:${id}:${tag}`);
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
    return task(id);
  },
  setSession(id, provider, session) {
    calls.push(`setSession:${id}:${provider}:${session ?? ''}`);
    return task(id);
  },
  taskSession(id) {
    calls.push(`taskSession:${id}`);
    const item = task(id);
    return {
      taskId: item.id,
      provider: item.provider,
      session: item.session,
      branch: item.branch,
      plan: item.plan,
    };
  },
  allIds() {
    calls.push('allIds');
    return [];
  },
  allTags() {
    calls.push('allTags');
    return [];
  },
  ...emptyProgressStoreMethods,
  close() {
    calls.push('close');
  },
});

/**
 * Creates a temporary directory and registers it for cleanup. Pass the array a
 * test file's `afterEach` drains so each suite owns its own teardown.
 */
export const createTemporaryDirectory = async (registry: string[]): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-'));
  registry.push(directory);
  return directory;
};

/**
 * Creates a temporary workspace root (a `package.json` declaring workspaces),
 * used to exercise setup commands that resolve a workspace.
 */
export const createWorkspaceRoot = async (registry: string[]): Promise<string> => {
  const root = await createTemporaryDirectory(registry);
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};
