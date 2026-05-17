import { describe, expect, it } from 'bun:test';
import type { CommandRunner } from './command-runner';
import { findWorktreeForBranch } from './git-status';

const runner =
  (stdout: string, exitCode = 0): CommandRunner =>
  async () => ({ exitCode, stdout, stderr: exitCode !== 0 ? stdout : '' });

const failRunner =
  (stderr: string): CommandRunner =>
  async () => ({ exitCode: 128, stdout: '', stderr });

const porcelain = (entries: { path: string; branch?: string }[]): string =>
  entries
    .map(({ path, branch }) => {
      const lines = [`worktree ${path}`, 'HEAD abc123'];
      if (branch) lines.push(`branch refs/heads/${branch}`);
      else lines.push('detached');
      return lines.join('\n');
    })
    .join('\n\n') + '\n\n';

describe('findWorktreeForBranch', () => {
  it('returns found with the path for a matching record', async () => {
    const output = porcelain([{ path: '/tmp/wt-abc', branch: 'task/abc' }]);
    const result = await findWorktreeForBranch('/project', 'task/abc', runner(output));
    expect(result).toEqual({ kind: 'found', path: '/tmp/wt-abc' });
  });

  it('returns not_found when no record matches', async () => {
    const output = porcelain([{ path: '/project', branch: 'main' }]);
    const result = await findWorktreeForBranch('/project', 'task/missing', runner(output));
    expect(result).toEqual({ kind: 'not_found' });
  });

  it('returns failed with stderr when the runner exits non-zero', async () => {
    const result = await findWorktreeForBranch(
      '/project',
      'task/any',
      failRunner('fatal: not a git repository'),
    );
    expect(result).toEqual({ kind: 'failed', stderr: 'fatal: not a git repository' });
  });

  it('skips detached/bare worktrees without confusing later records', async () => {
    const output = porcelain([
      { path: '/project/detached' }, // no branch line
      { path: '/tmp/wt-main', branch: 'main' },
      { path: '/tmp/wt-task', branch: 'task/abc' },
    ]);
    const result = await findWorktreeForBranch('/project', 'task/abc', runner(output));
    expect(result).toEqual({ kind: 'found', path: '/tmp/wt-task' });
  });

  it('does not cross-match branch lines from different records', async () => {
    const output =
      'worktree /wrong/path\nHEAD abc123\nbranch refs/heads/other\n\n' +
      'worktree /correct/path\nHEAD def456\nbranch refs/heads/task/abc\n\n';
    const result = await findWorktreeForBranch('/project', 'task/abc', runner(output));
    expect(result).toEqual({ kind: 'found', path: '/correct/path' });
  });
});
