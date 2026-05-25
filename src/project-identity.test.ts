import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectRejection } from '../test/store';
import type { CommandResult, CommandRunner } from './command-runner';
import {
  assertProjectMatchesWorkingTree,
  parseRepoName,
  requireProjectId,
  resolveProject,
} from './project-identity';
import { runMigrations } from './schema';

const directories: string[] = [];
const tempDir = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

const freshDatabase = (): Database => {
  const database = new Database(':memory:', { create: true, strict: true });
  runMigrations(database, () => new Date(), { projectRoot: '/tmp' });
  return database;
};

const initRepo = async (root: string): Promise<void> => {
  await Bun.spawn(['git', 'init'], { cwd: root, stdout: 'pipe', stderr: 'pipe' }).exited;
};

/** Builds a runner that replies to gh/remote per-cwd and delegates git otherwise. */
const runnerWith = (replies: {
  gh?: (cwd: string) => CommandResult;
  remote?: (cwd: string) => CommandResult;
}): CommandRunner => {
  return async (command, cwd): Promise<CommandResult> => {
    const joined = command.join(' ');
    if (joined.startsWith('gh repo view') && replies.gh) return replies.gh(cwd);
    if (joined === 'git remote get-url origin' && replies.remote) return replies.remote(cwd);
    const { runCommand } = await import('./command-runner');
    return runCommand(command, cwd);
  };
};

const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (): CommandResult => ({ exitCode: 1, stdout: '', stderr: '' });

describe('parseRepoName', () => {
  it('parses ssh and https remotes and rejects others', () => {
    expect(parseRepoName('git@github.com:octo/repo.git')).toBe('octo/repo');
    expect(parseRepoName('https://github.com/octo/repo.git')).toBe('octo/repo');
    expect(parseRepoName('https://github.com/octo/repo')).toBe('octo/repo');
    expect(parseRepoName('not a url')).toBeNull();
  });
});

describe('resolveProject rename + cache', () => {
  it('updates the name in place when gh reports a rename for the same working tree', async () => {
    const database = freshDatabase();
    const root = await tempDir('rename-');
    await initRepo(root);

    const first = await resolveProject(database, {
      cwd: root,
      runner: runnerWith({ gh: () => ok('octo/old\n'), remote: () => ok('') }),
    });
    expect(first.status === 'resolved' && first.nameWithOwner).toBe('octo/old');

    // A changed remote forces re-resolution; gh now reports the new name. The
    // surrogate id stays the same (same git_common_dir), so tasks stay attached.
    const renamed = await resolveProject(database, {
      cwd: root,
      runner: runnerWith({ gh: () => ok('octo/new\n'), remote: () => ok('changed\n') }),
    });
    expect(renamed.status === 'resolved' && renamed.id).toBe(
      first.status === 'resolved' ? first.id : -1,
    );
    expect(renamed.status === 'resolved' && renamed.nameWithOwner).toBe('octo/new');
    expect(database.query<{ c: number }, []>('SELECT COUNT(*) c FROM projects').get()?.c).toBe(1);
    database.close();
  });

  it('reuses the cached row when the remote is unchanged', async () => {
    const database = freshDatabase();
    const root = await tempDir('cache-');
    await initRepo(root);
    let ghCalls = 0;
    const runner = runnerWith({
      gh: () => {
        ghCalls += 1;
        return ok('octo/cached\n');
      },
      remote: () => ok('git@github.com:octo/cached.git\n'),
    });
    await resolveProject(database, { cwd: root, runner });
    await resolveProject(database, { cwd: root, runner });
    expect(ghCalls).toBe(1);
    database.close();
  });

  it('falls back to the cached row when gh later fails', async () => {
    const database = freshDatabase();
    const root = await tempDir('cachefail-');
    await initRepo(root);
    await resolveProject(database, {
      cwd: root,
      runner: runnerWith({ gh: () => ok('octo/cached\n'), remote: () => ok('r1\n') }),
    });
    // Remote changed (forces re-resolve) but gh now fails: keep the cached name.
    const result = await resolveProject(database, {
      cwd: root,
      runner: runnerWith({ gh: fail, remote: () => ok('r2\n') }),
    });
    expect(result.status === 'resolved' && result.nameWithOwner).toBe('octo/cached');
    database.close();
  });

  it('throws project_identity_conflict when a name is bound to another working tree', async () => {
    const database = freshDatabase();
    const rootA = await tempDir('conflictA-');
    const rootB = await tempDir('conflictB-');
    await initRepo(rootA);
    await initRepo(rootB);
    // Register `octo/dup` for rootA.
    await resolveProject(database, {
      cwd: rootA,
      runner: runnerWith({ gh: () => ok('octo/dup\n'), remote: () => ok('') }),
    });
    // rootB resolves to the same name but a different git_common_dir → conflict.
    await expectRejection(
      resolveProject(database, {
        cwd: rootB,
        runner: runnerWith({ gh: () => ok('octo/dup\n'), remote: () => ok('') }),
      }),
      { message: 'already registered' },
    );
    database.close();
  });

  it('is unresolved outside a git repository', async () => {
    const database = freshDatabase();
    const bare = await tempDir('bare-');
    const result = await resolveProject(database, { cwd: bare });
    expect(result.status).toBe('unresolved');
    database.close();
  });

  it('requireProjectId throws project_unresolved outside a repository', async () => {
    const database = freshDatabase();
    const bare = await tempDir('bare-');
    await expectRejection(requireProjectId(database, { cwd: bare }), {
      code: 'project_unresolved',
    });
    database.close();
  });
});

describe('assertProjectMatchesWorkingTree', () => {
  it('passes when the cached common dir matches the live one', async () => {
    const root = await tempDir('match-');
    await initRepo(root);
    const live = await realpath(join(root, '.git'));
    // Resolves without throwing.
    await assertProjectMatchesWorkingTree(
      { status: 'resolved', id: 1, nameWithOwner: 'octo/x', gitCommonDir: live },
      root,
    );
  });

  it('throws when the project is database-only (no git common dir)', async () => {
    const root = await tempDir('match-');
    await initRepo(root);
    await expectRejection(
      assertProjectMatchesWorkingTree(
        { status: 'resolved', id: 1, nameWithOwner: 'octo/x', gitCommonDir: null },
        root,
      ),
      { message: 'does not match' },
    );
  });

  it('throws when the working tree cannot be resolved', async () => {
    const bare = await tempDir('match-bare-');
    await expectRejection(
      assertProjectMatchesWorkingTree(
        { status: 'resolved', id: 1, nameWithOwner: 'octo/x', gitCommonDir: '/somewhere/.git' },
        bare,
      ),
      { code: 'project_root_mismatch' },
    );
  });
});
