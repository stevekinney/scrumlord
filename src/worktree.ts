import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CommandRunner } from './command-runner.js';
import { runCommand as defaultRunner } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import type { AgentProvider } from './types.js';

export type BaseBranch = { name: string; ref: string };

export type WorktreeResolution = {
  worktree: string;
  branch: string;
  shortId: string;
  base: BaseBranch;
  created: boolean;
};

/**
 * Resolves the repository's base branch. Probes candidates in order
 * (`origin/HEAD`, `init.defaultBranch`, literal `main`) and accepts the
 * first one that exists either as a remote-tracking ref or as a local head.
 */
export const resolveBaseBranch = async (
  projectRoot: string,
  runner: CommandRunner = defaultRunner,
): Promise<BaseBranch> => {
  const candidates = await baseBranchCandidates(projectRoot, runner);
  for (const name of candidates) {
    const ref = await verifiedRef(projectRoot, name, runner);
    if (ref) return { name, ref };
  }
  throw new ScrumlordError(
    'base_branch_unresolved',
    'Could not resolve a base branch from origin/HEAD, init.defaultBranch, or main.',
  );
};

const baseBranchCandidates = async (
  projectRoot: string,
  runner: CommandRunner,
): Promise<string[]> => {
  const candidates: string[] = [];
  const fromOrigin = await runner(
    ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    projectRoot,
  );
  if (fromOrigin.exitCode === 0) {
    const name = fromOrigin.stdout.trim().replace(/^origin\//, '');
    if (name) candidates.push(name);
  }
  const fromConfig = await runner(['git', 'config', 'init.defaultBranch'], projectRoot);
  if (fromConfig.exitCode === 0) {
    const name = fromConfig.stdout.trim();
    if (name) candidates.push(name);
  }
  candidates.push('main');
  return Array.from(new Set(candidates));
};

const verifiedRef = async (
  projectRoot: string,
  name: string,
  runner: CommandRunner,
): Promise<string | null> => {
  const remoteRef = `refs/remotes/origin/${name}`;
  const remote = await runner(['git', 'show-ref', '--verify', '--quiet', remoteRef], projectRoot);
  if (remote.exitCode === 0) return remoteRef;
  const localRef = `refs/heads/${name}`;
  const local = await runner(['git', 'show-ref', '--verify', '--quiet', localRef], projectRoot);
  if (local.exitCode === 0) return localRef;
  return null;
};

/**
 * Returns the absolute path of `git rev-parse --git-common-dir`. This is the
 * shared `.git/` directory regardless of whether `projectRoot` is the primary
 * checkout or a linked worktree, so it is the right identity for branch hashing
 * and worktree-ownership checks.
 */
export const repoCommonDir = async (
  projectRoot: string,
  runner: CommandRunner = defaultRunner,
): Promise<string> => {
  const result = await runner(['git', 'rev-parse', '--git-common-dir'], projectRoot);
  if (result.exitCode !== 0) {
    throw new ScrumlordError(
      'repo_common_dir_unresolved',
      `Could not resolve git common dir for ${projectRoot}: ${result.stderr.trim()}`,
    );
  }
  const candidate = result.stdout.trim();
  const absolute = resolve(projectRoot, candidate);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
};

/**
 * Derives the deterministic per-task branch name and short identifier from the
 * repository's common-dir path and the task id. Two checkouts that share a name
 * but differ in path produce different short-ids.
 */
export const deriveBranchAndShortId = (
  repoCommonDirectory: string,
  taskId: string,
): { branch: string; shortId: string } => {
  const hash = createHash('sha256').update(`${repoCommonDirectory}:${taskId}`).digest('hex');
  const shortId = hash.slice(0, 8);
  return { branch: `tasks/${shortId}`, shortId };
};

/**
 * Returns the absolute Scrumlord-managed worktree path for a task short-id.
 * Worktrees live under `<projectRoot>/tmp/worktrees/tasks/<shortId>` so a task's
 * branch (`tasks/<shortId>`), worktree directory, and task id all line up. The
 * `tmp/` location is gitignored; `ensureTaskWorktree` enforces that via
 * `assertTmpFallbackIgnored`.
 */
export const scrumlordWorktreePath = async (
  projectRoot: string,
  shortId: string,
): Promise<string> => {
  return join(projectRoot, 'tmp', 'worktrees', 'tasks', shortId);
};

/**
 * Ensures a Scrumlord-managed worktree exists for the task's branch. Reuses an
 * existing worktree when one matches the branch, otherwise materializes one
 * according to the resolution decision tree (local branch → remote-tracking →
 * base ref).
 */
export type WorktreeLog = (line: string) => void;

// eslint-disable-next-line complexity
export const ensureTaskWorktree = async (
  projectRoot: string,
  branch: string,
  base: BaseBranch,
  directory: string,
  runner: CommandRunner = defaultRunner,
  log?: WorktreeLog,
): Promise<{ worktree: string; created: boolean }> => {
  const existing = await worktreeForExactBranch(projectRoot, branch, runner);
  if (existing) {
    await assertWorktreeBelongsToRepo(projectRoot, existing, runner);
    return { worktree: existing, created: false };
  }

  if (existsSync(directory)) {
    await assertWorktreeBelongsToRepo(projectRoot, directory, runner);
  }

  await assertTmpFallbackIgnored(projectRoot, directory);

  const localExists = await runner(
    ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    projectRoot,
  );
  if (localExists.exitCode === 0) {
    log?.(`creating worktree at ${directory} from local branch ${branch}`);
    await runGit(['git', 'worktree', 'add', directory, branch], projectRoot, runner);
    return { worktree: directory, created: true };
  }

  const remoteExists = await runner(
    ['git', 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    projectRoot,
  );
  if (remoteExists.exitCode === 0) {
    log?.(`creating worktree at ${directory} from origin/${branch}`);
    await runGit(
      ['git', 'worktree', 'add', '-b', branch, directory, `refs/remotes/origin/${branch}`],
      projectRoot,
      runner,
    );
    return { worktree: directory, created: true };
  }

  if (base.ref.startsWith('refs/remotes/origin/')) {
    log?.(`fetching origin/${base.name}`);
    const fetch = await runner(['git', 'fetch', 'origin', base.name], projectRoot);
    if (fetch.exitCode !== 0) {
      // Best-effort fetch; fall through to whichever ref we have.
      // The downstream `git worktree add` will fail loudly if base.ref is truly missing.
    }
  }
  log?.(`creating worktree at ${directory} from ${base.ref}`);
  await runGit(['git', 'worktree', 'add', '-b', branch, directory, base.ref], projectRoot, runner);
  return { worktree: directory, created: true };
};

const worktreeForExactBranch = async (
  projectRoot: string,
  branch: string,
  runner: CommandRunner,
): Promise<string | null> => {
  const result = await runner(['git', 'worktree', 'list', '--porcelain'], projectRoot);
  if (result.exitCode !== 0) return null;
  const target = `branch refs/heads/${branch}`;
  let current: string | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    if (line === target && current) return current;
  }
  return null;
};

const assertWorktreeBelongsToRepo = async (
  projectRoot: string,
  candidate: string,
  runner: CommandRunner,
): Promise<void> => {
  const ours = await repoCommonDir(projectRoot, runner);
  let theirs: string;
  try {
    theirs = await repoCommonDir(candidate, runner);
  } catch {
    throw new ScrumlordError(
      'worktree_collision',
      `Directory exists but is not a git worktree of this repository: ${candidate}.`,
    );
  }
  if (ours !== theirs) {
    throw new ScrumlordError(
      'worktree_collision',
      `Worktree path ${candidate} belongs to a different repository (${theirs} vs ${ours}).`,
    );
  }
};

const assertTmpFallbackIgnored = async (projectRoot: string, directory: string): Promise<void> => {
  const tmpFallback = join(projectRoot, 'tmp', 'worktrees');
  if (!directory.startsWith(tmpFallback)) return;
  const gitignorePath = join(projectRoot, '.gitignore');
  if (!existsSync(gitignorePath)) {
    throw new ScrumlordError(
      'tmp_not_ignored',
      `Refusing to use ${directory}: project has no .gitignore covering tmp/.`,
    );
  }
  const contents = await Bun.file(gitignorePath).text();
  const covers = contents
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === 'tmp' || line === 'tmp/' || line === '/tmp' || line === '/tmp/');
  if (!covers) {
    throw new ScrumlordError(
      'tmp_not_ignored',
      `Refusing to use ${directory}: .gitignore does not cover tmp/.`,
    );
  }
};

const runGit = async (command: string[], cwd: string, runner: CommandRunner): Promise<void> => {
  const result = await runner(command, cwd);
  if (result.exitCode !== 0) {
    throw new ScrumlordError(
      'git_worktree_failed',
      `${command.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
};

const providerCapabilityFlag: Record<AgentProvider, { flag: RegExp; code: string }> = {
  claude: { flag: /--worktree\b/, code: 'MISSING_CLAUDE_WORKTREE' },
  codex: { flag: /(?:^|\s)(?:-C|--cd)\b/, code: 'MISSING_CODEX_CD' },
};

/**
 * Verifies the provider CLI advertises the flag this command depends on.
 * Throws `ScrumlordError` before any state mutation if the flag is absent
 * or the binary is unusable.
 */
export const checkProviderCapabilities = async (
  provider: AgentProvider,
  runner: CommandRunner = defaultRunner,
  projectRoot: string = process.cwd(),
): Promise<void> => {
  const probe = providerCapabilityFlag[provider];
  const help = await runner([provider, '--help'], projectRoot);
  if (help.exitCode !== 0) {
    throw new ScrumlordError(
      'PROVIDER_CLI_UNUSABLE',
      `${provider} --help failed (exit ${help.exitCode}): ${help.stderr.trim() || help.stdout.trim()}.`,
    );
  }
  if (probe.flag.test(help.stdout) || probe.flag.test(help.stderr)) return;
  throw new ScrumlordError(
    probe.code,
    `${provider} CLI does not advertise the required flag in --help output.`,
  );
};
