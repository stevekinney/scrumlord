/* eslint-disable max-lines, complexity */
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { getAgentProvider, type AgentInvocation } from './agent-providers.js';
import { prepareTaskWorktree } from './cli-agent-commands.js';
import { createTheme, type ColorMode, type Theme } from './color.js';
import { runCommand, type CommandRunner } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import { pullRequestStatus, pullRequestsForBranch, repositoryName } from './github.js';
import {
  formatPipelinePhaseMarker,
  parsePipelineMarker,
  type PipelinePhase,
} from './pipeline-markers.js';
import {
  classifyTaskForRecovery,
  type PipelinePullRequest,
  type RecoveryInputs,
  type RecoveryOutcome,
  type RecoveryVerdict,
} from './pipeline-recovery.js';
import { PIPELINE_SYSTEM_PROMPT, addressPrPrompt, pipelinePrompt } from './pipeline-prompts.js';
import type { AgentProvider, Task, TaskStore } from './types.js';
import { deriveBranchAndShortId, repoCommonDir, resolveBaseBranch } from './worktree.js';

/* ---------- Tunable constants (env-overridable, strict clamps) ---------- */

type ClampRule = { default: number; min: number; max: number };

const CONSTANT_CLAMP_RULES: Record<string, ClampRule> = {
  CHECK_POLL_INTERVAL_MS: { default: 30_000, min: 1_000, max: 300_000 },
  CHECK_POLL_MAX_ATTEMPTS: { default: 120, min: 1, max: 1_000 },
  REVIEW_BOT_WAIT_MS: { default: 60_000, min: 1_000, max: 600_000 },
  REVIEW_BOT_MAX_ATTEMPTS: { default: 5, min: 1, max: 100 },
  ADDRESS_PR_MAX_ROUNDS: { default: 5, min: 1, max: 20 },
  AGENT_IDLE_MS: { default: 600_000, min: 60_000, max: 21_600_000 },
  AGENT_MAX_MS: { default: 14_400_000, min: 60_000, max: 21_600_000 },
  LOCK_STALE_MS: { default: 6 * 60 * 60 * 1_000, min: 60_000, max: 24 * 60 * 60 * 1_000 },
};

export type PipelineConstants = {
  CHECK_POLL_INTERVAL_MS: number;
  CHECK_POLL_MAX_ATTEMPTS: number;
  REVIEW_BOT_WAIT_MS: number;
  REVIEW_BOT_MAX_ATTEMPTS: number;
  ADDRESS_PR_MAX_ROUNDS: number;
  AGENT_IDLE_MS: number;
  AGENT_MAX_MS: number;
  LOCK_STALE_MS: number;
};

const parseEnvInteger = (
  name: string,
  raw: string | undefined,
  rule: { default: number; min: number; max: number },
): number => {
  if (raw === undefined || raw === '') return rule.default;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ScrumlordError('pipeline_env_invalid', `${name}=${raw} is not a valid integer.`);
  }
  if (parsed < rule.min || parsed > rule.max) {
    throw new ScrumlordError(
      'pipeline_env_out_of_range',
      `${name}=${raw} is outside the allowed range [${rule.min}, ${rule.max}].`,
    );
  }
  return parsed;
};

/** Resolves pipeline constants from environment with strict clamps. Throws on invalid input. */
export const resolvePipelineConstants = (
  environment: Record<string, string | undefined> = Bun.env,
): PipelineConstants => {
  const out: Partial<PipelineConstants> = {};
  for (const [name, rule] of Object.entries(CONSTANT_CLAMP_RULES)) {
    const envKey = `SCRUMLORD_PIPELINE_${name}`;
    out[name as keyof PipelineConstants] = parseEnvInteger(envKey, environment[envKey], rule);
  }
  return out as PipelineConstants;
};

/* ---------- Types ---------- */

export type PipelineMode = 'drain' | 'recover' | 'recover-then-run' | 'resume';

export type PipelineOptions = {
  provider: AgentProvider;
  mode: PipelineMode;
  /** Maximum claim attempts in drain mode. Undefined means unlimited. */
  max?: number;
  /** When true with mode=recover or recover-then-run, dispatch mutating actions. */
  apply?: boolean;
  /** Resume-mode target. */
  resumeTaskId?: string;
  quiet?: boolean;
  dryRun?: boolean;
  /** Injectable command runner; defaults to live shell. */
  runner?: CommandRunner;
  /** Injectable agent spawn; defaults to live subprocess via Bun.spawn. */
  spawnAgent?: SpawnAgent;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep; defaults to Bun.sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable signal-handler registration; defaults to process.on. */
  signals?: SignalRegistrar;
  /** Injectable stderr sink; defaults to process.stderr.write. */
  stderr?: (line: string) => void;
  /** Pre-resolved constants (otherwise read from env). */
  constants?: PipelineConstants;
  /** Pre-minted run id for testing. */
  runId?: string;
  /** Override hostname (testing). */
  hostname?: string;
  /** Pre-resolved repository name (testing). */
  repository?: string;
  /** Color mode for human-readable status output. Defaults to 'auto'. */
  colorMode?: ColorMode;
};

export type SpawnAgentResult = {
  exitCode: number;
  /** Non-empty when the agent emitted a `STUCK: …` line on stderr. */
  stuck: string | null;
  /** True when the parent killed the child due to idle or hard timeout. */
  killed: 'idle' | 'hard' | null;
};

export type SpawnAgent = (
  invocation: AgentInvocation,
  caps: { idleMs: number; maxMs: number },
  controls: { stderr: (line: string) => void; signal: AbortSignal },
) => Promise<SpawnAgentResult>;

export type SignalRegistrar = (handler: (signal: NodeJS.Signals) => void) => () => void;

export type TaskOutcome = {
  taskId: string;
  branch: string | null;
  pullRequestNumber: number | null;
  reason: string;
};

export type PipelineSummary = {
  startedAt: string;
  finishedAt: string;
  exitCode: PipelineExitCode;
  shipped: TaskOutcome[];
  skipped: TaskOutcome[];
  failed: TaskOutcome[];
  recovery: RecoveryOutcome[] | null;
  effectiveSettings: PipelineConstants & { runId: string };
};

export type PipelineExitCode = 0 | 1 | 2 | 3 | 4 | 5;

/* ---------- Lockfile ---------- */

const LOCKFILE_PATH = (projectRoot: string): string => join(projectRoot, 'tmp', 'pipeline.lock');

const writeLockfile = (path: string, runId: string, now: number, host: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    runId,
    startedAt: new Date(now).toISOString(),
    hostname: host,
  });
  writeFileSync(path, payload, { flag: 'wx' });
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
};

type LockfileState = { pid: number; runId: string; startedAt: string; hostname: string };

const readLockfile = (path: string): LockfileState | null => {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockfileState>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.runId === 'string' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.hostname === 'string'
    ) {
      return parsed as LockfileState;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Acquires the per-project pipeline lockfile. Returns the release callback or throws
 * `pipeline_already_running` when another live pipeline holds the lock.
 */
export const acquirePipelineLock = (
  projectRoot: string,
  runId: string,
  options: { now?: () => number; staleMs?: number; hostname?: string } = {},
): (() => void) => {
  const path = LOCKFILE_PATH(projectRoot);
  const now = options.now ?? Date.now;
  const stale = options.staleMs ?? CONSTANT_CLAMP_RULES['LOCK_STALE_MS']!.default;
  const host = options.hostname ?? hostname();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeLockfile(path, runId, now(), host);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          // ignore
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const existing = readLockfile(path);
      if (!existing) {
        try {
          unlinkSync(path);
        } catch {
          // ignore
        }
        continue;
      }
      const aliveCheck = !isPidAlive(existing.pid);
      const ageMs = now() - Date.parse(existing.startedAt);
      const stalePid = aliveCheck || (Number.isFinite(ageMs) && ageMs > stale);
      if (!stalePid) {
        throw new ScrumlordError(
          'pipeline_already_running',
          `Another pipeline is running (pid ${existing.pid}, started ${existing.startedAt}).`,
        );
      }
      try {
        unlinkSync(path);
      } catch {
        // ignore — next iteration will fail if it really still exists
      }
    }
  }
  throw new ScrumlordError(
    'pipeline_lock_unavailable',
    'Could not acquire pipeline lockfile after stale-reap retry.',
  );
};

/* ---------- Run id ---------- */

const generateRunId = (): string => crypto.randomUUID();

/* ---------- Status output ---------- */

const defaultStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

type LogContext = {
  stderr: (line: string) => void;
  quiet: boolean;
  theme: Theme;
  shortRunId: string;
  now: () => number;
};

type LogLevel = 'step' | 'info' | 'success' | 'warning' | 'error' | 'muted';

const levelGlyph: Record<LogLevel, string> = {
  step: '▶',
  info: '·',
  success: '✓',
  warning: '⚠',
  error: '✗',
  muted: '…',
};

const formatTimestamp = (now: () => number): string => {
  const date = new Date(now());
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const colorForLevel = (theme: Theme, level: LogLevel): ((value: string) => string) => {
  if (level === 'success') return theme.success;
  if (level === 'warning') return theme.warning;
  if (level === 'error') return theme.error;
  if (level === 'step') return theme.heading;
  if (level === 'muted') return theme.muted;
  return theme.command;
};

const log = (ctx: LogContext, level: LogLevel, message: string, taskId?: string): void => {
  if (
    ctx.quiet &&
    (level === 'info' || level === 'muted' || level === 'step' || level === 'success')
  )
    return;
  const stamp = ctx.theme.muted(`[${formatTimestamp(ctx.now)} ${ctx.shortRunId}]`);
  const colorize = colorForLevel(ctx.theme, level);
  const glyph = colorize(levelGlyph[level]);
  const taskTag = taskId ? ` ${ctx.theme.argument(taskId.slice(0, 8))}` : '';
  ctx.stderr(`${stamp} ${glyph}${taskTag} ${message}`);
};

/**
 * Renders a one-line PR readiness snapshot the operator can grep for. Every
 * count appears in every line so a single log entry shows the full state of
 * checks and review comments. `botsPending` is omitted when empty so the
 * common case stays terse.
 */
export const formatSnapshot = (input: {
  pass: number;
  pending: number;
  fail: number;
  unresolved: number;
  botsPending?: readonly string[];
}): string => {
  const pass = Math.max(0, input.pass);
  const base = `pass=${pass} pending=${input.pending} fail=${input.fail} unresolved=${input.unresolved}`;
  if (input.botsPending && input.botsPending.length > 0) {
    return `${base} bots-pending=${input.botsPending.join(',')}`;
  }
  return base;
};

const formatDuration = (milliseconds: number): string => {
  const totalSeconds = Math.round(milliseconds / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
};

/* ---------- Agent spawn ---------- */

const defaultSpawnAgent: SpawnAgent = async (invocation, caps, controls) => {
  const child = Bun.spawn(invocation.command, {
    cwd: invocation.cwd,
    env: { ...Bun.env, ...invocation.environment },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let lastActivity = Date.now();
  let stuck: string | null = null;
  let killed: 'idle' | 'hard' | null = null;
  const start = Date.now();
  const decoder = new TextDecoder();

  const checkTimeouts = setInterval(() => {
    const now = Date.now();
    if (now - lastActivity > caps.idleMs && killed === null) {
      killed = 'idle';
      child.kill('SIGTERM');
      return;
    }
    if (now - start > caps.maxMs && killed === null) {
      killed = 'hard';
      child.kill('SIGTERM');
    }
  }, 1_000);

  // Visible heartbeat from the parent. `claude -p` over a pipe does not stream
  // its TUI output, so without this the operator sees nothing for 5+ minutes
  // while the agent is working. The heartbeat goes to stderr in plain text
  // (no theme) every ~30s so it survives non-TTY contexts.
  const heartbeatIntervalMs = 30_000;
  const heartbeat = setInterval(() => {
    if (killed !== null) return;
    const now = Date.now();
    const elapsedMs = now - start;
    const idleMs = now - lastActivity;
    const elapsedSeconds = Math.round(elapsedMs / 1000);
    const idleSeconds = Math.round(idleMs / 1000);
    const idleCapSeconds = Math.round(caps.idleMs / 1000);
    controls.stderr(
      `agent still running (${elapsedSeconds}s elapsed, last activity ${idleSeconds}s ago, idle cap ${idleCapSeconds}s)\n`,
    );
  }, heartbeatIntervalMs);

  const onAbort = (): void => {
    killed = killed ?? 'hard';
    child.kill('SIGTERM');
  };
  controls.signal.addEventListener('abort', onAbort);

  const drainStdout = (async () => {
    for await (const chunk of child.stdout) {
      lastActivity = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      controls.stderr(text);
    }
  })();
  const drainStderr = (async () => {
    let buffer = '';
    for await (const chunk of child.stderr) {
      lastActivity = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      controls.stderr(text);
      buffer += text;
      const match = /STUCK:\s*(.+)$/m.exec(buffer);
      if (match) stuck = match[1]!.trim();
    }
  })();

  try {
    await Promise.all([drainStdout, drainStderr]);
  } finally {
    clearInterval(checkTimeouts);
    clearInterval(heartbeat);
    controls.signal.removeEventListener('abort', onAbort);
  }

  if (killed === 'idle') {
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  }

  const exitCode = await child.exited;
  return { exitCode, stuck, killed };
};

/* ---------- Per-task driver ---------- */

type ResolvedOptions = {
  provider: AgentProvider;
  runner: CommandRunner;
  spawnAgent: SpawnAgent;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stderr: (line: string) => void;
  quiet: boolean;
  dryRun: boolean;
  constants: PipelineConstants;
  runId: string;
  shortRunId: string;
  hostname: string;
  repository: string | null;
  theme: Theme;
};

const recordPhase = (
  store: TaskStore,
  taskId: string,
  phase: PipelinePhase,
  runId: string,
  now: () => number,
): void => {
  const marker = formatPipelinePhaseMarker(phase, taskId, runId, new Date(now()).toISOString());
  store.addProgress(taskId, { message: marker });
};

/**
 * Writes a human-readable pipeline note to the task progress log so `tasks progress`
 * reflects everything the pipeline is doing. Prefixed `pipeline:` so future tooling
 * can distinguish pipeline-authored notes from agent-authored ones.
 */
const recordProgress = (store: TaskStore, taskId: string, note: string): void => {
  store.addProgress(taskId, { message: `pipeline: ${note}` });
};

/** Returns the PR number for a task's branch, or a structured failure. */
export const pullRequestForTask = async (
  projectRoot: string,
  task: Task,
  runner: CommandRunner,
  repository: string | null,
): Promise<
  | { kind: 'found'; pullRequest: PipelinePullRequest }
  | { kind: 'none' }
  | { kind: 'multiple'; pullRequests: PipelinePullRequest[] }
  | { kind: 'unavailable'; reason: string }
> => {
  if (!task.branch) return { kind: 'none' };
  try {
    const repo = repository ?? (await repositoryName(projectRoot, { runner }));
    const prs = await pullRequestsForBranch(projectRoot, repo, task.branch, { runner });
    const matching: PipelinePullRequest[] = prs
      .filter((pr) => pr.headRefName === task.branch)
      .map((pr) => ({
        number: pr.number,
        state: pr.state,
        baseRefName: pr.baseRefName,
        mergedAt: pr.mergedAt,
        url: pr.url,
      }));
    if (matching.length === 0) return { kind: 'none' };
    if (matching.length === 1) return { kind: 'found', pullRequest: matching[0]! };
    return { kind: 'multiple', pullRequests: matching };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: 'unavailable', reason };
  }
};

/** Merges a PR if it is ready but not yet merged. No-ops when already merged. */
export const mergeIfNeeded = async (
  projectRoot: string,
  pullRequest: PipelinePullRequest,
  runner: CommandRunner,
): Promise<{ merged: boolean; reason?: string }> => {
  if (pullRequest.state === 'MERGED') return { merged: true };
  const result = await runner(
    ['gh', 'pr', 'merge', String(pullRequest.number), '--squash', '--delete-branch'],
    projectRoot,
  );
  if (result.exitCode !== 0) {
    return { merged: false, reason: result.stderr.trim() || result.stdout.trim() };
  }
  return { merged: true };
};

type RunOneTaskResult =
  | { kind: 'shipped'; outcome: TaskOutcome }
  | { kind: 'skipped'; outcome: TaskOutcome }
  | { kind: 'failed'; outcome: TaskOutcome };

/** Runs one task end-to-end: prepare worktree, spawn agent, poll PR, merge, complete. */
export const runOneTask = async (
  store: TaskStore,
  taskId: string,
  resolved: ResolvedOptions,
): Promise<RunOneTaskResult> => {
  const current = store.getTask(taskId);
  if (!current) {
    return failed(taskId, null, null, 'task_disappeared');
  }
  if (current.status === 'completed' || current.deleted || current.archived) {
    return skipped(taskId, current.branch, null, `terminal_state:${describeTerminal(current)}`);
  }

  // Prepare worktree via the shared helper. We pass persistClaim:false because
  // claimNext already moved the row to in-progress and we don't want to double-write.
  let prepared;
  try {
    prepared = await prepareTaskWorktree(store, taskId, {
      provider: resolved.provider,
      runner: resolved.runner,
      stderr: resolved.stderr,
      quiet: resolved.quiet,
      persistClaim: false,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failed(taskId, current.branch, null, `worktree_prepare_failed:${reason}`);
  }

  const branch = prepared.branch;
  const worktree = prepared.worktree;
  // Persist branch + provider while preserving the claimed in-progress status.
  const adapter = getAgentProvider(resolved.provider);
  const session = adapter.createSession();
  store.update(taskId, {
    status: 'in-progress',
    provider: resolved.provider,
    session: session ?? prepared.task.session,
    branch,
  });
  recordPhase(store, taskId, 'branch-set', resolved.runId, resolved.now);

  const titleLabel = current.title ? ` — ${current.title}` : '';
  log(
    resolved,
    'step',
    `claimed${titleLabel} on branch ${resolved.theme.command(branch)}, provider ${resolved.theme.option(resolved.provider)}`,
    taskId,
  );
  // Worktree path on its own undecorated line (#14) — easy to spot and copy.
  resolved.stderr(`tip: cd ${worktree}`);
  recordProgress(
    store,
    taskId,
    `claimed by pipeline run ${resolved.shortRunId} (branch ${branch}, ${resolved.provider})`,
  );

  const invocation = buildPipelineInvocation(resolved.provider, taskId, branch, worktree);
  log(
    resolved,
    'info',
    `spawning ${resolved.theme.option(resolved.provider)} agent (idle cap ${formatDuration(resolved.constants.AGENT_IDLE_MS)}, hard cap ${formatDuration(resolved.constants.AGENT_MAX_MS)})`,
    taskId,
  );
  recordProgress(store, taskId, `spawning ${resolved.provider} agent in worktree`);
  const abort = new AbortController();
  const agentStartedAt = resolved.now();
  const spawnResult = await resolved.spawnAgent(
    invocation,
    { idleMs: resolved.constants.AGENT_IDLE_MS, maxMs: resolved.constants.AGENT_MAX_MS },
    { stderr: resolved.stderr, signal: abort.signal },
  );
  const agentElapsed = formatDuration(resolved.now() - agentStartedAt);
  if (spawnResult.killed === 'idle') {
    log(resolved, 'error', `agent idle-timeout after ${agentElapsed}`, taskId);
    recordProgress(store, taskId, `agent killed (idle-timeout after ${agentElapsed})`);
    return failed(taskId, branch, null, 'agent_idle');
  }
  if (spawnResult.killed === 'hard') {
    log(resolved, 'error', `agent hard-timeout after ${agentElapsed}`, taskId);
    recordProgress(store, taskId, `agent killed (hard-timeout after ${agentElapsed})`);
    return failed(taskId, branch, null, 'agent_timeout');
  }
  if (spawnResult.exitCode !== 0) {
    const reason = spawnResult.stuck ? `stuck:${spawnResult.stuck}` : 'agent_failed';
    log(
      resolved,
      'error',
      `agent exited ${spawnResult.exitCode} after ${agentElapsed} (${reason})`,
      taskId,
    );
    recordProgress(
      store,
      taskId,
      `agent exited ${spawnResult.exitCode} after ${agentElapsed} (${reason})`,
    );
    return failed(taskId, branch, null, reason);
  }
  log(resolved, 'success', `agent finished after ${agentElapsed}`, taskId);
  recordProgress(store, taskId, `agent finished cleanly after ${agentElapsed}`);
  recordPhase(store, taskId, 'agent-exited', resolved.runId, resolved.now);

  return await pollPrUntilMerged(store, taskId, branch, resolved);
};

const buildPipelineInvocation = (
  provider: AgentProvider,
  taskId: string,
  branch: string,
  worktree: string,
): AgentInvocation => {
  const body = pipelinePrompt(provider, taskId);
  if (provider === 'claude') {
    return {
      command: [
        'claude',
        '-p',
        '--dangerously-skip-permissions',
        '--worktree',
        branch,
        '--append-system-prompt',
        PIPELINE_SYSTEM_PROMPT,
        body,
      ],
      cwd: worktree,
      environment: {},
    };
  }
  return {
    command: ['codex', '--cd', worktree, `${PIPELINE_SYSTEM_PROMPT}\n\n${body}`],
    cwd: worktree,
    environment: {},
  };
};

const buildAddressPrInvocation = (
  provider: AgentProvider,
  taskId: string,
  pullRequestNumber: number,
  worktree: string,
  branch: string,
): AgentInvocation => {
  const body = addressPrPrompt(taskId, pullRequestNumber);
  if (provider === 'claude') {
    return {
      command: ['claude', '-p', '--dangerously-skip-permissions', '--worktree', branch, body],
      cwd: worktree,
      environment: {},
    };
  }
  return {
    command: ['codex', '--cd', worktree, body],
    cwd: worktree,
    environment: {},
  };
};

/** Polls the task's PR through merge, dispatching /address-pr when needed. */
const pollPrUntilMerged = async (
  store: TaskStore,
  taskId: string,
  branch: string,
  resolved: ResolvedOptions,
): Promise<RunOneTaskResult> => {
  let prRecorded = false;
  const totalRounds = resolved.constants.ADDRESS_PR_MAX_ROUNDS;
  log(resolved, 'info', `entering PR polling loop (max ${totalRounds} rounds)`, taskId);
  for (let round = 1; round <= totalRounds; round++) {
    log(
      resolved,
      'muted',
      `poll round ${round}/${totalRounds}: looking up PR for branch ${resolved.theme.command(branch)}`,
      taskId,
    );
    const task = store.getTask(taskId);
    if (!task) return failed(taskId, branch, null, 'task_disappeared');
    let prResult = await pullRequestForTask(
      store.projectRoot,
      task,
      resolved.runner,
      resolved.repository,
    );
    if (prResult.kind === 'unavailable') {
      log(resolved, 'error', `PR lookup unavailable: ${prResult.reason}`, taskId);
      return failed(taskId, branch, null, `pr_lookup_unavailable:${prResult.reason}`);
    }
    if (prResult.kind === 'multiple') {
      log(resolved, 'error', `multiple PRs match branch ${branch}`, taskId);
      return failed(taskId, branch, null, 'multiple_prs');
    }
    if (prResult.kind === 'none') {
      log(
        resolved,
        'muted',
        `no PR yet; sleeping ${formatDuration(resolved.constants.CHECK_POLL_INTERVAL_MS)} before rechecking`,
        taskId,
      );
      await resolved.sleep(resolved.constants.CHECK_POLL_INTERVAL_MS);
      prResult = await pullRequestForTask(
        store.projectRoot,
        task,
        resolved.runner,
        resolved.repository,
      );
      if (prResult.kind !== 'found') {
        log(resolved, 'error', 'agent finished but no PR was opened', taskId);
        return failed(taskId, branch, null, 'pr_never_opened');
      }
    }
    if (prResult.kind !== 'found') return failed(taskId, branch, null, 'pr_never_opened');
    const pullRequest = prResult.pullRequest;
    if (!prRecorded) {
      recordPhase(store, taskId, 'pr-created', resolved.runId, resolved.now);
      recordProgress(
        store,
        taskId,
        `pull request #${pullRequest.number} opened: ${pullRequest.url}`,
      );
      log(resolved, 'success', `PR #${pullRequest.number} found`, taskId);
      resolved.stderr(pullRequest.url);
      prRecorded = true;
    }

    // Already-merged success branch — checked first.
    if (pullRequest.state === 'MERGED') {
      log(
        resolved,
        'success',
        `PR #${pullRequest.number} already merged; syncing task state`,
        taskId,
      );
      await syncAndRefresh(store, taskId, resolved);
      const refreshed = store.getTask(taskId);
      if (refreshed?.status === 'completed') {
        recordPhase(store, taskId, 'merge', resolved.runId, resolved.now);
        recordProgress(store, taskId, `PR #${pullRequest.number} merged; task completed`);
        log(resolved, 'success', `task completed (PR #${pullRequest.number} merged)`, taskId);
        return shipped(taskId, branch, pullRequest.number, 'merged');
      }
    }

    let status;
    try {
      status = await pullRequestStatus(store.projectRoot, {
        runner: resolved.runner,
        pullRequestNumber: pullRequest.number,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(resolved, 'error', `status lookup failed: ${reason}`, taskId);
      return failed(taskId, branch, pullRequest.number, `status_lookup_unavailable:${reason}`);
    }
    const snapshot = formatSnapshot({
      pass:
        status.continuousIntegration.checks.length -
        status.continuousIntegration.pendingCount -
        status.continuousIntegration.failedCount,
      pending: status.continuousIntegration.pendingCount,
      fail: status.continuousIntegration.failedCount,
      unresolved: status.reviewComments.unresolvedCount,
    });
    log(
      resolved,
      'info',
      `PR #${pullRequest.number} state=${status.pullRequest.state} readyToMerge=${status.readyToMerge} ${snapshot}`,
      taskId,
    );

    if (status.readyToMerge) {
      if (status.pullRequest.state !== 'MERGED') {
        log(resolved, 'step', `merging PR #${pullRequest.number}`, taskId);
        const merge = await mergeIfNeeded(
          store.projectRoot,
          {
            number: status.pullRequest.number,
            state: status.pullRequest.state,
            baseRefName: status.pullRequest.baseRefName,
            mergedAt: status.pullRequest.mergedAt,
            url: status.pullRequest.url,
          },
          resolved.runner,
        );
        if (!merge.merged) {
          log(resolved, 'error', `merge failed: ${merge.reason ?? 'unknown'}`, taskId);
          recordProgress(store, taskId, `merge failed: ${merge.reason ?? 'unknown'}`);
          return failed(
            taskId,
            branch,
            pullRequest.number,
            `merge_failed:${merge.reason ?? 'unknown'}`,
          );
        }
        log(resolved, 'success', `PR #${pullRequest.number} merged`, taskId);
        recordProgress(store, taskId, `PR #${pullRequest.number} merged by pipeline`);
      }
      await syncAndRefresh(store, taskId, resolved);
      const refreshed = store.getTask(taskId);
      if (refreshed?.status === 'completed') {
        recordPhase(store, taskId, 'merge', resolved.runId, resolved.now);
        recordProgress(store, taskId, `task shipped (PR #${pullRequest.number} merged)`);
        log(resolved, 'success', `task shipped`, taskId);
        return shipped(taskId, branch, pullRequest.number, 'merged');
      }
      log(resolved, 'error', 'PR merged but task did not transition to completed', taskId);
      recordProgress(store, taskId, 'PR merged but task did not transition to completed');
      return failed(taskId, branch, pullRequest.number, 'merged_but_not_completed');
    }

    if (status.continuousIntegration.failedCount > 0 || status.reviewComments.unresolvedCount > 0) {
      recordPhase(store, taskId, 'address-pr', resolved.runId, resolved.now);
      recordProgress(
        store,
        taskId,
        `dispatching /address-pr ${pullRequest.number}: ${status.continuousIntegration.failedCount} failing check(s), ${status.reviewComments.unresolvedCount} unresolved comment(s)`,
      );
      log(
        resolved,
        'step',
        `dispatching /address-pr ${pullRequest.number} (${status.continuousIntegration.failedCount} failing checks, ${status.reviewComments.unresolvedCount} unresolved comments)`,
        taskId,
      );
      const worktree = await worktreeForTask(store.projectRoot, branch, resolved.runner);
      const invocation = buildAddressPrInvocation(
        resolved.provider,
        taskId,
        pullRequest.number,
        worktree,
        branch,
      );
      const abort = new AbortController();
      const addressStartedAt = resolved.now();
      const spawn = await resolved.spawnAgent(
        invocation,
        { idleMs: resolved.constants.AGENT_IDLE_MS, maxMs: resolved.constants.AGENT_MAX_MS },
        { stderr: resolved.stderr, signal: abort.signal },
      );
      const addressElapsed = formatDuration(resolved.now() - addressStartedAt);
      if (spawn.killed === 'idle') {
        log(resolved, 'error', `address-pr agent idle-timeout after ${addressElapsed}`, taskId);
        recordProgress(
          store,
          taskId,
          `address-pr agent killed (idle-timeout after ${addressElapsed})`,
        );
        return failed(taskId, branch, pullRequest.number, 'agent_idle');
      }
      if (spawn.killed === 'hard') {
        log(resolved, 'error', `address-pr agent hard-timeout after ${addressElapsed}`, taskId);
        recordProgress(
          store,
          taskId,
          `address-pr agent killed (hard-timeout after ${addressElapsed})`,
        );
        return failed(taskId, branch, pullRequest.number, 'agent_timeout');
      }
      if (spawn.exitCode !== 0) {
        const reason = spawn.stuck ? `stuck:${spawn.stuck}` : 'address_pr_failed';
        log(
          resolved,
          'error',
          `address-pr exited ${spawn.exitCode} after ${addressElapsed} (${reason})`,
          taskId,
        );
        recordProgress(
          store,
          taskId,
          `address-pr exited ${spawn.exitCode} after ${addressElapsed} (${reason})`,
        );
        return failed(taskId, branch, pullRequest.number, reason);
      }
      log(resolved, 'success', `address-pr finished after ${addressElapsed}`, taskId);
      recordProgress(store, taskId, `address-pr finished cleanly after ${addressElapsed}`);
      await syncAndRefresh(store, taskId, resolved);
      continue;
    }

    log(
      resolved,
      'muted',
      `Checks pending (${round}/${totalRounds}) — sleeping ${formatDuration(resolved.constants.CHECK_POLL_INTERVAL_MS)}: ${snapshot}`,
      taskId,
    );
    await resolved.sleep(resolved.constants.CHECK_POLL_INTERVAL_MS);
  }
  log(resolved, 'error', `address-pr cap (${totalRounds}) reached without merging`, taskId);
  recordProgress(store, taskId, `address-pr cap (${totalRounds}) reached without merging`);
  return failed(taskId, branch, null, 'address_pr_cap_reached');
};

const worktreeForTask = async (
  projectRoot: string,
  branch: string,
  runner: CommandRunner,
): Promise<string> => {
  const result = await runner(['git', 'worktree', 'list', '--porcelain'], projectRoot);
  if (result.exitCode !== 0) return projectRoot;
  let current: string | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}` && current) return current;
  }
  return projectRoot;
};

const syncAndRefresh = async (
  store: TaskStore,
  taskId: string,
  resolved: ResolvedOptions,
): Promise<void> => {
  log(resolved, 'muted', 'syncing GitHub state into local task store', taskId);
  const { syncGitStatus } = await import('./git-status.js');
  try {
    await syncGitStatus(store, { runner: resolved.runner });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(resolved, 'warning', `sync_git_status_failed: ${reason}`, taskId);
  }
};

const describeTerminal = (task: Task): string => {
  if (task.deleted) return 'deleted';
  if (task.archived) return 'archived';
  return task.status;
};

const shipped = (
  taskId: string,
  branch: string | null,
  pullRequestNumber: number | null,
  reason: string,
): { kind: 'shipped'; outcome: TaskOutcome } => ({
  kind: 'shipped',
  outcome: { taskId, branch, pullRequestNumber, reason },
});

const skipped = (
  taskId: string,
  branch: string | null,
  pullRequestNumber: number | null,
  reason: string,
): { kind: 'skipped'; outcome: TaskOutcome } => ({
  kind: 'skipped',
  outcome: { taskId, branch, pullRequestNumber, reason },
});

const failed = (
  taskId: string,
  branch: string | null,
  pullRequestNumber: number | null,
  reason: string,
): { kind: 'failed'; outcome: TaskOutcome } => ({
  kind: 'failed',
  outcome: { taskId, branch, pullRequestNumber, reason },
});

/* ---------- Recovery sweep driver ---------- */

const phaseFromMarker = (message: string): PipelinePhase | null => {
  return parsePipelineMarker(message)?.phase ?? null;
};

const collectProgressPhases = (store: TaskStore, taskId: string): PipelinePhase[] => {
  return store
    .progress(taskId)
    .map((entry) => phaseFromMarker(entry.message))
    .filter((phase): phase is PipelinePhase => phase !== null);
};

const gatherRecoveryInputs = async (
  store: TaskStore,
  task: Task,
  runner: CommandRunner,
  repository: string | null,
  now: number,
): Promise<RecoveryInputs> => {
  // eslint-disable-next-line typescript-eslint/no-redundant-type-constituents
  let resolvedBaseBranch: string | 'unknown' = 'unknown';
  try {
    const base = await resolveBaseBranch(store.projectRoot, runner);
    resolvedBaseBranch = base.name;
  } catch {
    resolvedBaseBranch = 'unknown';
  }

  let common = '';
  try {
    common = await repoCommonDir(store.projectRoot, runner);
  } catch {
    common = '';
  }

  let provenance: RecoveryInputs['branchProvenance'] = 'unknown';
  if (task.branch && common) {
    const expected = deriveBranchAndShortId(common, task.id).branch;
    provenance = task.branch === expected ? 'task-derived' : 'foreign';
  } else if (!task.branch) {
    provenance = 'task-derived'; // moot; will fall through to no-branch logic
  }

  let worktreePath: string | null = null;
  if (task.branch) {
    const wt = await worktreeForTask(store.projectRoot, task.branch, runner);
    if (wt !== store.projectRoot) worktreePath = wt;
  }

  // Worktree dirty / unpushed: best effort.
  let worktreeDirty: boolean | 'unknown' = false;
  let worktreeUnpushed: number | 'unknown' = 0;
  if (worktreePath) {
    const dirty = await runner(['git', 'status', '--porcelain'], worktreePath);
    if (dirty.exitCode !== 0) worktreeDirty = 'unknown';
    else worktreeDirty = dirty.stdout.trim().length > 0;
    const ahead = await runner(['git', 'rev-list', '--count', '@{u}..HEAD'], worktreePath);
    if (ahead.exitCode !== 0) worktreeUnpushed = 'unknown';
    else worktreeUnpushed = Number(ahead.stdout.trim()) || 0;
  }

  // Remote branch presence and commits-ahead.
  let remoteBranchExists: boolean | 'unknown' = false;
  let remoteCommitsAheadOfMain: number | 'unknown' = 0;
  if (task.branch) {
    const ls = await runner(
      ['git', 'ls-remote', '--heads', 'origin', task.branch],
      store.projectRoot,
    );
    if (ls.exitCode !== 0) {
      remoteBranchExists = 'unknown';
      remoteCommitsAheadOfMain = 'unknown';
    } else {
      remoteBranchExists = ls.stdout.trim().length > 0;
      if (remoteBranchExists && resolvedBaseBranch !== 'unknown') {
        const ahead = await runner(
          ['git', 'rev-list', '--count', `origin/${resolvedBaseBranch}..origin/${task.branch}`],
          store.projectRoot,
        );
        if (ahead.exitCode !== 0) remoteCommitsAheadOfMain = 'unknown';
        else remoteCommitsAheadOfMain = Number(ahead.stdout.trim()) || 0;
      }
    }
  }

  let candidatePullRequests: RecoveryInputs['candidatePullRequests'] = [];
  if (task.branch && repository) {
    try {
      const prs = await pullRequestsForBranch(store.projectRoot, repository, task.branch, {
        runner,
      });
      candidatePullRequests = prs
        .filter((pr) => pr.headRefName === task.branch)
        .map((pr) => ({
          number: pr.number,
          state: pr.state,
          baseRefName: pr.baseRefName,
          mergedAt: pr.mergedAt,
          url: pr.url,
        }));
    } catch {
      candidatePullRequests = 'unknown';
    }
  } else if (task.branch && !repository) {
    candidatePullRequests = 'unknown';
  }

  return {
    task,
    resolvedBaseBranch,
    worktreePath,
    worktreeDirty,
    worktreeUnpushed,
    remoteBranchExists,
    remoteCommitsAheadOfMain,
    candidatePullRequests,
    progressPhases: collectProgressPhases(store, task.id),
    branchProvenance: provenance,
    now,
  };
};

/** Runs the recovery sweep over every stranded task. Annotate-only unless `apply` is true. */
export const runRecoverySweep = async (
  store: TaskStore,
  resolved: ResolvedOptions,
  apply: boolean,
): Promise<RecoveryOutcome[]> => {
  const stranded = store
    .list({ includeInactive: false })
    .filter((task) => task.status === 'in-progress' || task.status === 'in-review');
  log(resolved, 'info', `${stranded.length} stranded task(s) to classify`);
  const outcomes: RecoveryOutcome[] = [];
  for (const task of stranded) {
    log(resolved, 'muted', `gathering recovery inputs for ${task.title}`, task.id);
    const recoveryInputs = await gatherRecoveryInputs(
      store,
      task,
      resolved.runner,
      resolved.repository,
      resolved.now(),
    );
    const verdict = classifyTaskForRecovery(recoveryInputs);
    const applied = apply && (verdict.kind === 'rollback-safe' || verdict.kind === 'complete-safe');
    if (applied) {
      log(resolved, 'step', `verdict ${annotationFor(verdict)} (applying mutation)`, task.id);
      dispatchRecoveryMutation(store, task, verdict, resolved);
    } else {
      const note = annotationFor(verdict);
      log(
        resolved,
        verdict.kind === 'manual' ? 'warning' : 'info',
        `verdict ${note}${apply ? '' : ' (annotate-only)'}`,
        task.id,
      );
      store.addProgress(task.id, { message: `pipeline:recovery=${note}` });
    }
    outcomes.push({ taskId: task.id, verdict, applied });
  }
  return outcomes;
};

const dispatchRecoveryMutation = (
  store: TaskStore,
  task: Task,
  verdict: RecoveryVerdict,
  resolved: ResolvedOptions,
): void => {
  if (verdict.kind === 'rollback-safe') {
    store.update(task.id, { status: 'ready', branch: null });
    return;
  }
  if (verdict.kind === 'complete-safe') {
    store.update(task.id, { status: 'completed' });
    return;
  }
  void resolved;
};

const annotationFor = (verdict: RecoveryVerdict): string => {
  if (verdict.kind === 'manual') return `manual:${verdict.code}`;
  if (verdict.kind === 'resumable') {
    return verdict.needsPr === true ? 'resumable:needs-pr' : 'resumable';
  }
  return verdict.kind;
};

/* ---------- Outer drain loop ---------- */

const resolveOptions = async (
  options: PipelineOptions,
  projectRoot: string,
): Promise<ResolvedOptions> => {
  const constants = options.constants ?? resolvePipelineConstants();
  const runner = options.runner ?? runCommand;
  let repository: string | null = options.repository ?? null;
  if (!repository) {
    try {
      repository = await repositoryName(projectRoot, { runner });
    } catch {
      repository = null;
    }
  }
  const runId = options.runId ?? generateRunId();
  const colorMode: ColorMode = options.colorMode ?? 'auto';
  return {
    provider: options.provider,
    runner,
    spawnAgent: options.spawnAgent ?? defaultSpawnAgent,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? Bun.sleep,
    stderr: options.stderr ?? defaultStderr,
    quiet: options.quiet ?? false,
    dryRun: options.dryRun ?? false,
    constants,
    runId,
    shortRunId: runId.slice(0, 8),
    hostname: options.hostname ?? hostname(),
    repository,
    theme: createTheme(colorMode),
  };
};

const finalizeSummary = (
  resolved: ResolvedOptions,
  startedAt: string,
  exitCode: PipelineExitCode,
  shipped: TaskOutcome[],
  skipped: TaskOutcome[],
  failed: TaskOutcome[],
  recovery: RecoveryOutcome[] | null,
): PipelineSummary => {
  return {
    startedAt,
    finishedAt: new Date(resolved.now()).toISOString(),
    exitCode,
    shipped,
    skipped,
    failed,
    recovery,
    effectiveSettings: { ...resolved.constants, runId: resolved.runId },
  };
};

/** Top-level driver. */
export const runPipeline = async (
  store: TaskStore,
  options: PipelineOptions,
): Promise<PipelineSummary> => {
  // Minimal startup line — emitted BEFORE option resolution so an env-var
  // validation failure inside resolveOptions still surfaces something visible
  // to the operator. Uses the caller-supplied runId when present so the early
  // line matches the later banner; otherwise mints one and threads it through.
  const startupRunId = options.runId ?? generateRunId();
  const startupStderr = options.stderr ?? defaultStderr;
  startupStderr(`[${startupRunId.slice(0, 8)}] tasks pipeline starting…`);

  const resolved = await resolveOptions({ ...options, runId: startupRunId }, store.projectRoot);
  const startedAt = new Date(resolved.now()).toISOString();
  const wallStart = resolved.now();
  const shippedOutcomes: TaskOutcome[] = [];
  const skippedOutcomes: TaskOutcome[] = [];
  const failedOutcomes: TaskOutcome[] = [];
  let recovery: RecoveryOutcome[] | null = null;

  logBanner(resolved, options);

  if (resolved.dryRun) {
    log(resolved, 'step', 'dry-run: previewing claim order without writes');
    const candidates = store.listClaimCandidates(options.max ?? 50);
    log(resolved, 'info', `would claim ${candidates.length} task(s)`);
    for (const task of candidates) {
      log(
        resolved,
        'muted',
        `→ would claim ${resolved.theme.argument(task.id.slice(0, 8))} (priority ${task.priority}, ${task.title})`,
      );
      skippedOutcomes.push({
        taskId: task.id,
        branch: task.branch,
        pullRequestNumber: null,
        reason: 'dry_run_would_claim',
      });
    }
    const summary = finalizeSummary(
      resolved,
      startedAt,
      0,
      shippedOutcomes,
      skippedOutcomes,
      failedOutcomes,
      null,
    );
    logSummary(resolved, summary, resolved.now() - wallStart);
    return summary;
  }

  log(resolved, 'muted', `acquiring pipeline lock`);
  const release = acquirePipelineLock(store.projectRoot, resolved.runId, {
    now: resolved.now,
    staleMs: resolved.constants.LOCK_STALE_MS,
    hostname: resolved.hostname,
  });
  log(resolved, 'success', `pipeline lock acquired`);
  try {
    if (options.mode === 'recover' || options.mode === 'recover-then-run') {
      log(
        resolved,
        'step',
        `running recovery sweep (${options.apply === true ? 'apply' : 'annotate-only'})`,
      );
      recovery = await runRecoverySweep(store, resolved, options.apply === true);
      log(resolved, 'info', `recovery sweep produced ${recovery.length} verdict(s)`);
      if (options.mode === 'recover') {
        const manualPresent = recovery.some((outcome) => outcome.verdict.kind === 'manual');
        const exit: PipelineExitCode = manualPresent ? 4 : 0;
        const summary = finalizeSummary(
          resolved,
          startedAt,
          exit,
          shippedOutcomes,
          skippedOutcomes,
          failedOutcomes,
          recovery,
        );
        logSummary(resolved, summary, resolved.now() - wallStart);
        return summary;
      }
      // recover-then-run: refuse to drain while resumable verdicts exist.
      const resumablePresent = recovery.some((outcome) => outcome.verdict.kind === 'resumable');
      if (resumablePresent) {
        log(resolved, 'error', 'resumable tasks present. Use `--resume <id>` first.');
        const summary = finalizeSummary(
          resolved,
          startedAt,
          4,
          shippedOutcomes,
          skippedOutcomes,
          failedOutcomes,
          recovery,
        );
        logSummary(resolved, summary, resolved.now() - wallStart);
        return summary;
      }
    }

    if (options.mode === 'resume') {
      if (!options.resumeTaskId) {
        log(resolved, 'error', 'resume mode requires --resume <task-id>');
        const summary = finalizeSummary(
          resolved,
          startedAt,
          2,
          shippedOutcomes,
          skippedOutcomes,
          failedOutcomes,
          recovery,
        );
        logSummary(resolved, summary, resolved.now() - wallStart);
        return summary;
      }
      log(resolved, 'step', `resuming task`, options.resumeTaskId);
      const result = await runOneTask(store, options.resumeTaskId, resolved);
      record(result, shippedOutcomes, skippedOutcomes, failedOutcomes);
      const exit: PipelineExitCode = result.kind === 'shipped' ? 0 : 1;
      const summary = finalizeSummary(
        resolved,
        startedAt,
        exit,
        shippedOutcomes,
        skippedOutcomes,
        failedOutcomes,
        recovery,
      );
      logSummary(resolved, summary, resolved.now() - wallStart);
      return summary;
    }

    // Drain mode (and recover-then-run after sweep).
    log(resolved, 'step', `draining queue${options.max ? ` (max ${options.max} attempts)` : ''}`);
    let attempts = 0;
    let exit: PipelineExitCode = 0;
    while (options.max === undefined || attempts < options.max) {
      const task = store.claimNext({ runId: resolved.runId });
      if (!task) {
        if (attempts === 0) {
          const summary = store.summarizeReadyQueue();
          log(
            resolved,
            'warning',
            `ready-queue breakdown: ${summary.ready} ready, ${summary.blocked} blocked, ${summary.inProgress} in-progress, ${summary.inReview} in-review, ${summary.draft} draft, ${summary.completed} completed`,
          );
          log(resolved, 'warning', 'queue empty; nothing to drain');
        } else {
          log(resolved, 'success', 'queue drained');
        }
        break;
      }
      attempts += 1;
      log(
        resolved,
        'step',
        `[attempt ${attempts}${options.max ? `/${options.max}` : ''}] claimed: ${task.title}`,
        task.id,
      );
      const result = await runOneTask(store, task.id, resolved);
      record(result, shippedOutcomes, skippedOutcomes, failedOutcomes);
      log(
        resolved,
        result.kind === 'shipped' ? 'success' : result.kind === 'skipped' ? 'warning' : 'error',
        `attempt ${attempts} ${result.kind}: ${result.outcome.reason}`,
        task.id,
      );
      if (result.kind === 'failed') {
        exit = 1;
        log(resolved, 'warning', 'stopping pipeline on failed task (on-stuck=stop)');
        break;
      }
    }
    const summary = finalizeSummary(
      resolved,
      startedAt,
      exit,
      shippedOutcomes,
      skippedOutcomes,
      failedOutcomes,
      recovery,
    );
    logSummary(resolved, summary, resolved.now() - wallStart);
    return summary;
  } finally {
    log(resolved, 'muted', 'releasing pipeline lock');
    release();
  }
};

const record = (
  result: RunOneTaskResult,
  shipped: TaskOutcome[],
  skipped: TaskOutcome[],
  failed: TaskOutcome[],
): void => {
  if (result.kind === 'shipped') shipped.push(result.outcome);
  else if (result.kind === 'skipped') skipped.push(result.outcome);
  else failed.push(result.outcome);
};

const logBanner = (resolved: ResolvedOptions, options: PipelineOptions): void => {
  const { theme } = resolved;
  const modeLabel = theme.argument(options.mode);
  const providerLabel = theme.option(resolved.provider);
  const dryRun = resolved.dryRun ? theme.warning(' [dry-run]') : '';
  const max = options.max ? theme.muted(` max=${options.max}`) : '';
  resolved.stderr(
    `${theme.title('━━━ tasks pipeline ━━━')} ${theme.muted(`run=${resolved.shortRunId}`)} mode=${modeLabel} cli=${providerLabel}${max}${dryRun}`,
  );
  if (resolved.repository) {
    log(resolved, 'muted', `repository ${resolved.theme.command(resolved.repository)}`);
  }
};

const logSummary = (
  resolved: ResolvedOptions,
  summary: PipelineSummary,
  elapsedMs: number,
): void => {
  const { theme } = resolved;
  const shipped = theme.success(`shipped ${summary.shipped.length}`);
  const skipped = theme.warning(`skipped ${summary.skipped.length}`);
  const failedCount = theme.error(`failed ${summary.failed.length}`);
  const exit =
    summary.exitCode === 0
      ? theme.success(`exit=${summary.exitCode}`)
      : theme.error(`exit=${summary.exitCode}`);
  resolved.stderr(
    `${theme.title('━━━ summary ━━━')} ${shipped}  ${skipped}  ${failedCount}  ${theme.muted(`(${formatDuration(elapsedMs)})`)}  ${exit}`,
  );
  for (const outcome of summary.shipped) {
    resolved.stderr(
      `  ${theme.success('✓')} ${theme.argument(outcome.taskId.slice(0, 8))} ${theme.muted(outcome.reason)}${outcome.pullRequestNumber ? theme.muted(` PR #${outcome.pullRequestNumber}`) : ''}`,
    );
  }
  for (const outcome of summary.skipped) {
    resolved.stderr(
      `  ${theme.warning('•')} ${theme.argument(outcome.taskId.slice(0, 8))} ${theme.muted(outcome.reason)}`,
    );
  }
  for (const outcome of summary.failed) {
    resolved.stderr(
      `  ${theme.error('✗')} ${theme.argument(outcome.taskId.slice(0, 8))} ${theme.muted(outcome.reason)}`,
    );
  }
  if (summary.recovery && summary.recovery.length > 0) {
    resolved.stderr(`${theme.heading('recovery verdicts:')}`);
    for (const outcome of summary.recovery) {
      const verdictLabel = annotationFor(outcome.verdict);
      const applied = outcome.applied
        ? theme.success(' [applied]')
        : theme.muted(' [annotate-only]');
      resolved.stderr(`  ${theme.argument(outcome.taskId.slice(0, 8))} ${verdictLabel}${applied}`);
    }
  }
};
