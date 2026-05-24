import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from './command-runner';
import { ScrumlordError } from './errors';
import {
  checkProviderCapabilities,
  deriveBranchAndShortId,
  ensureTaskWorktree,
  repoCommonDir,
  resolveBaseBranch,
  scrumlordWorktreePath,
} from './worktree';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-worktree-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = ''): CommandResult => ({ exitCode: 1, stdout: '', stderr });

type FakeRunnerEntry = (command: string[], cwd: string) => CommandResult;

const scriptedRunner = (script: FakeRunnerEntry[]): CommandRunner => {
  let index = 0;
  return async (command, cwd) => {
    const entry = script[index];
    index += 1;
    if (!entry) throw new Error(`Unexpected command: ${command.join(' ')}`);
    return entry(command, cwd);
  };
};

const matchingRunner = (
  matchers: Array<{ match: RegExp; reply: CommandResult }>,
): CommandRunner => {
  return async (command) => {
    const joined = command.join(' ');
    for (const matcher of matchers) {
      if (matcher.match.test(joined)) return matcher.reply;
    }
    return fail(`no matcher for ${joined}`);
  };
};

const caught = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the action to throw, but it resolved.');
};

describe('deriveBranchAndShortId', () => {
  it('produces a stable 8-char hash keyed on common dir', () => {
    const a = deriveBranchAndShortId('/repo-a/.git', 'task-1');
    const b = deriveBranchAndShortId('/repo-b/.git', 'task-1');
    expect(a.shortId).toHaveLength(8);
    expect(a.branch).toBe(`tasks/${a.shortId}`);
    expect(a.shortId).not.toBe(b.shortId);
    expect(deriveBranchAndShortId('/repo-a/.git', 'task-1')).toEqual(a);
  });

  it('uses repo common dir, not display-only slug', () => {
    const first = deriveBranchAndShortId('/foo/scrumlord/.git', 'task');
    const second = deriveBranchAndShortId('/bar/scrumlord/.git', 'task');
    expect(first.shortId).not.toBe(second.shortId);
  });
});

describe('resolveBaseBranch', () => {
  it('prefers origin/HEAD when present', async () => {
    const runner = matchingRunner([
      { match: /symbolic-ref --short refs\/remotes\/origin\/HEAD/, reply: ok('origin/main\n') },
      {
        match: /show-ref --verify --quiet refs\/remotes\/origin\/main/,
        reply: ok(),
      },
    ]);
    expect(await resolveBaseBranch('/repo', runner)).toEqual({
      name: 'main',
      ref: 'refs/remotes/origin/main',
    });
  });

  it('falls through to init.defaultBranch when origin/HEAD missing', async () => {
    const runner = matchingRunner([
      { match: /symbolic-ref/, reply: fail() },
      { match: /config init\.defaultBranch/, reply: ok('trunk\n') },
      { match: /show-ref --verify --quiet refs\/remotes\/origin\/trunk/, reply: fail() },
      { match: /show-ref --verify --quiet refs\/heads\/trunk/, reply: ok() },
      { match: /show-ref/, reply: fail() },
    ]);
    expect(await resolveBaseBranch('/repo', runner)).toEqual({
      name: 'trunk',
      ref: 'refs/heads/trunk',
    });
  });

  it('falls back to literal main only if it exists', async () => {
    const runner = matchingRunner([
      { match: /symbolic-ref/, reply: fail() },
      { match: /config init\.defaultBranch/, reply: fail() },
      { match: /show-ref --verify --quiet refs\/remotes\/origin\/main/, reply: ok() },
    ]);
    expect(await resolveBaseBranch('/repo', runner)).toEqual({
      name: 'main',
      ref: 'refs/remotes/origin/main',
    });
  });

  it('fails base_branch_unresolved when nothing verifies', async () => {
    const runner = matchingRunner([
      { match: /symbolic-ref/, reply: fail() },
      { match: /config/, reply: fail() },
      { match: /show-ref/, reply: fail() },
    ]);
    expect(await caught(() => resolveBaseBranch('/repo', runner))).toMatchObject({
      code: 'base_branch_unresolved',
    });
  });
});

describe('repoCommonDir', () => {
  it('resolves the git common dir to an absolute path', async () => {
    const root = await temporaryDirectory();
    const runner: CommandRunner = async () => ok('.git\n');
    expect(await repoCommonDir(root, runner)).toBe(join(root, '.git').replace(/\/$/, ''));
  });

  it('throws when git rev-parse fails', async () => {
    const runner: CommandRunner = async () => fail('not a git repo');
    expect(await caught(() => repoCommonDir('/no-where', runner))).toMatchObject({
      code: 'repo_common_dir_unresolved',
    });
  });
});

describe('scrumlordWorktreePath', () => {
  it('places the worktree at tmp/worktrees/tasks/<shortId> under the project root', async () => {
    const projectRoot = await temporaryDirectory();
    expect(await scrumlordWorktreePath(projectRoot, 'd41d8cd9')).toBe(
      join(projectRoot, 'tmp', 'worktrees', 'tasks', 'd41d8cd9'),
    );
  });
});

describe('ensureTaskWorktree', () => {
  const base = { name: 'main', ref: 'refs/remotes/origin/main' as const };

  it('reuses an existing worktree on the same branch', async () => {
    const projectRoot = await temporaryDirectory();
    const existingDir = await temporaryDirectory();
    const projectGitDir = join(projectRoot, '.git');
    await mkdir(projectGitDir, { recursive: true });
    const runner = scriptedRunner([
      () => ok(`worktree ${existingDir}\nHEAD abc\nbranch refs/heads/task/abcd1234\n`),
      () => ok(`${projectGitDir}\n`),
      () => ok(`${projectGitDir}\n`),
    ]);
    const result = await ensureTaskWorktree(
      projectRoot,
      'task/abcd1234',
      base,
      join(await temporaryDirectory(), 'unused'),
      runner,
    );
    expect(result).toEqual({ worktree: existingDir, created: false });
  });

  it('attaches to an existing local branch', async () => {
    const projectRoot = await temporaryDirectory();
    const directory = join(projectRoot, 'wt');
    const runner = scriptedRunner([
      () => ok(''), // worktree list (no match)
      () => ok(), // show-ref refs/heads/task/...
      (command) => {
        expect(command).toEqual(['git', 'worktree', 'add', directory, 'task/abcd1234']);
        return ok();
      },
    ]);
    const result = await ensureTaskWorktree(projectRoot, 'task/abcd1234', base, directory, runner);
    expect(result).toEqual({ worktree: directory, created: true });
  });

  it('attaches to a remote-tracking branch when local missing', async () => {
    const projectRoot = await temporaryDirectory();
    const directory = join(projectRoot, 'wt');
    const runner = scriptedRunner([
      () => ok(''),
      () => fail(), // local missing
      () => ok(), // remote present
      (command) => {
        expect(command).toEqual([
          'git',
          'worktree',
          'add',
          '-b',
          'task/abcd1234',
          directory,
          'refs/remotes/origin/task/abcd1234',
        ]);
        return ok();
      },
    ]);
    const result = await ensureTaskWorktree(projectRoot, 'task/abcd1234', base, directory, runner);
    expect(result).toEqual({ worktree: directory, created: true });
  });

  it('creates a new branch from base.ref after best-effort fetch', async () => {
    const projectRoot = await temporaryDirectory();
    const directory = join(projectRoot, 'wt');
    let fetched = false;
    const runner: CommandRunner = async (command) => {
      const joined = command.join(' ');
      if (joined === 'git worktree list --porcelain') return ok('');
      if (joined === 'git show-ref --verify --quiet refs/heads/task/abcd1234') return fail();
      if (joined === 'git show-ref --verify --quiet refs/remotes/origin/task/abcd1234')
        return fail();
      if (joined === 'git fetch origin main') {
        fetched = true;
        return ok();
      }
      if (joined === `git worktree add -b task/abcd1234 ${directory} refs/remotes/origin/main`)
        return ok();
      return fail(`unexpected ${joined}`);
    };
    const result = await ensureTaskWorktree(projectRoot, 'task/abcd1234', base, directory, runner);
    expect(result).toEqual({ worktree: directory, created: true });
    expect(fetched).toBe(true);
  });

  it('treats a failed fetch as non-fatal', async () => {
    const projectRoot = await temporaryDirectory();
    const directory = join(projectRoot, 'wt');
    const runner: CommandRunner = async (command) => {
      const joined = command.join(' ');
      if (joined === 'git worktree list --porcelain') return ok('');
      if (joined.startsWith('git show-ref')) return fail();
      if (joined === 'git fetch origin main') return fail('offline');
      if (joined === `git worktree add -b task/abcd1234 ${directory} refs/remotes/origin/main`)
        return ok();
      return fail(`unexpected ${joined}`);
    };
    const result = await ensureTaskWorktree(projectRoot, 'task/abcd1234', base, directory, runner);
    expect(result.created).toBe(true);
  });

  it('refuses an existing dir whose common-dir points to a different repo', async () => {
    const projectRoot = await temporaryDirectory();
    const directory = await temporaryDirectory();
    const projectGitDir = join(projectRoot, '.git');
    await mkdir(projectGitDir, { recursive: true });
    const otherGitDir = '/other/.git';
    const runner: CommandRunner = async (command, cwd) => {
      const joined = command.join(' ');
      if (joined === 'git worktree list --porcelain') return ok('');
      if (joined === 'git rev-parse --git-common-dir') {
        if (cwd === projectRoot) return ok('.git\n');
        return ok(otherGitDir + '\n');
      }
      return fail(`unexpected ${joined}`);
    };
    expect(
      await caught(() => ensureTaskWorktree(projectRoot, 'task/abcd1234', base, directory, runner)),
    ).toMatchObject({ code: 'worktree_collision' });
  });

  it('refuses tmp/worktrees fallback when .gitignore is missing entirely', async () => {
    const projectRoot = await temporaryDirectory();
    const directory = join(projectRoot, 'tmp', 'worktrees', 'scrumlord-abcd1234');
    const runner: CommandRunner = async (command) => {
      const joined = command.join(' ');
      if (joined === 'git worktree list --porcelain') return ok('');
      return fail();
    };
    expect(
      await caught(() => ensureTaskWorktree(projectRoot, 'task/abcd1234', base, directory, runner)),
    ).toMatchObject({ code: 'tmp_not_ignored' });
  });

  it('refuses to reuse an existing dir that is not a git worktree', async () => {
    const projectRoot = await temporaryDirectory();
    const existingDir = await temporaryDirectory();
    const runner: CommandRunner = async (command, cwd) => {
      const joined = command.join(' ');
      if (joined === 'git worktree list --porcelain') return ok('');
      if (joined === 'git rev-parse --git-common-dir') {
        if (cwd === projectRoot) return ok('.git\n');
        return fail('not a git repo');
      }
      return fail(`unexpected ${joined}`);
    };
    expect(
      await caught(() =>
        ensureTaskWorktree(projectRoot, 'task/abcd1234', base, existingDir, runner),
      ),
    ).toMatchObject({ code: 'worktree_collision' });
  });

  it('surfaces git worktree add failure as git_worktree_failed', async () => {
    const projectRoot = await temporaryDirectory();
    const directory = join(projectRoot, 'wt');
    const runner: CommandRunner = async (command) => {
      const joined = command.join(' ');
      if (joined === 'git worktree list --porcelain') return ok('');
      if (joined === 'git show-ref --verify --quiet refs/heads/task/abcd1234') return ok();
      if (joined.startsWith('git worktree add ')) return fail('fatal: bad ref');
      return fail(`unexpected ${joined}`);
    };
    expect(
      await caught(() => ensureTaskWorktree(projectRoot, 'task/abcd1234', base, directory, runner)),
    ).toMatchObject({ code: 'git_worktree_failed' });
  });

  it('refuses tmp/worktrees fallback when .gitignore omits tmp', async () => {
    const projectRoot = await temporaryDirectory();
    await writeFile(join(projectRoot, '.gitignore'), 'node_modules/\n');
    const directory = join(projectRoot, 'tmp', 'worktrees', 'scrumlord-abcd1234');
    const runner: CommandRunner = async (command) => {
      const joined = command.join(' ');
      if (joined === 'git worktree list --porcelain') return ok('');
      return fail(`unexpected ${joined}`);
    };
    expect(
      await caught(() => ensureTaskWorktree(projectRoot, 'task/abcd1234', base, directory, runner)),
    ).toMatchObject({ code: 'tmp_not_ignored' });
  });

  it('accepts tmp/worktrees fallback when .gitignore covers tmp', async () => {
    const projectRoot = await temporaryDirectory();
    await writeFile(join(projectRoot, '.gitignore'), 'tmp/\n');
    const directory = join(projectRoot, 'tmp', 'worktrees', 'scrumlord-abcd1234');
    const runner: CommandRunner = async (command) => {
      const joined = command.join(' ');
      if (joined === 'git worktree list --porcelain') return ok('');
      if (joined === 'git show-ref --verify --quiet refs/heads/task/abcd1234') return fail();
      if (joined === 'git show-ref --verify --quiet refs/remotes/origin/task/abcd1234')
        return fail();
      if (joined === 'git fetch origin main') return ok();
      if (joined === `git worktree add -b task/abcd1234 ${directory} refs/remotes/origin/main`)
        return ok();
      return fail(`unexpected ${joined}`);
    };
    const result = await ensureTaskWorktree(projectRoot, 'task/abcd1234', base, directory, runner);
    expect(result.created).toBe(true);
  });
});

describe('checkProviderCapabilities', () => {
  it('accepts claude with --worktree present in help', async () => {
    const runner: CommandRunner = async () => ok('Options:\n  -w, --worktree [name]\n');
    expect(await checkProviderCapabilities('claude', runner)).toBeUndefined();
  });

  it('rejects claude without --worktree', async () => {
    const runner: CommandRunner = async () => ok('Options:\n  -h, --help\n');
    expect(await caught(() => checkProviderCapabilities('claude', runner))).toMatchObject({
      code: 'MISSING_CLAUDE_WORKTREE',
    });
  });

  it('accepts codex with --cd present in help', async () => {
    const runner: CommandRunner = async () => ok('Options:\n  -C, --cd <DIR>\n');
    expect(await checkProviderCapabilities('codex', runner)).toBeUndefined();
  });

  it('rejects codex without -C/--cd', async () => {
    const runner: CommandRunner = async () => ok('Options:\n  -h, --help\n');
    expect(await caught(() => checkProviderCapabilities('codex', runner))).toMatchObject({
      code: 'MISSING_CODEX_CD',
    });
  });

  it('reports PROVIDER_CLI_UNUSABLE when --help itself fails', async () => {
    const runner: CommandRunner = async () => fail('command not found');
    const error = await caught(() => checkProviderCapabilities('claude', runner));
    expect(error).toBeInstanceOf(ScrumlordError);
    expect(error).toMatchObject({ code: 'PROVIDER_CLI_UNUSABLE' });
  });
});
