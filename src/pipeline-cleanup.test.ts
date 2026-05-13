import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cleanupWorktreeAfterMerge, type LogLevel } from './pipeline';
import type { CommandResult, CommandRunner } from './command-runner';

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = ''): CommandResult => ({ exitCode: 1, stdout: '', stderr });

type RunnerCall = { command: string[]; cwd: string };

const recordingRunner = (
  responder: (joined: string, command: string[]) => CommandResult,
): { runner: CommandRunner; calls: RunnerCall[] } => {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (command, cwd) => {
    calls.push({ command: [...command], cwd: cwd ?? '' });
    return responder(command.join(' '), command);
  };
  return { runner, calls };
};

const recordingLog = (): { log: (level: LogLevel, message: string) => void; lines: string[] } => {
  const lines: string[] = [];
  const log = (level: LogLevel, message: string): void => {
    lines.push(`${level}:${message}`);
  };
  return { log, lines };
};

describe('cleanupWorktreeAfterMerge', () => {
  let originalCleanup: string | undefined;
  beforeEach(() => {
    originalCleanup = Bun.env['SCRUMLORD_PIPELINE_CLEANUP'];
  });
  afterEach(() => {
    if (originalCleanup === undefined) delete process.env['SCRUMLORD_PIPELINE_CLEANUP'];
    else process.env['SCRUMLORD_PIPELINE_CLEANUP'] = originalCleanup;
  });

  it('keep mode is a no-op (default behavior)', async () => {
    delete process.env['SCRUMLORD_PIPELINE_CLEANUP'];
    const { runner, calls } = recordingRunner(() => ok());
    const { log } = recordingLog();
    await cleanupWorktreeAfterMerge({
      worktree: '/scratch/worktrees/task',
      branch: 'task/abc12345',
      projectRoot: '/scratch/project',
      runner,
      log,
    });
    expect(calls).toEqual([]);
  });

  it('remove mode runs `git worktree remove` without --force, then `git branch -d`', async () => {
    process.env['SCRUMLORD_PIPELINE_CLEANUP'] = 'remove';
    const { runner, calls } = recordingRunner(() => ok());
    const { log, lines } = recordingLog();
    await cleanupWorktreeAfterMerge({
      worktree: '/scratch/worktrees/task',
      branch: 'task/abc12345',
      projectRoot: '/scratch/project',
      runner,
      log,
    });
    expect(calls.length).toBe(2);
    expect(calls[0]!.command).toEqual(['git', 'worktree', 'remove', '/scratch/worktrees/task']);
    expect(calls[1]!.command).toEqual(['git', 'branch', '-d', 'task/abc12345']);
    expect(lines.some((line) => line.startsWith('muted:removed worktree'))).toBe(true);
    expect(lines.some((line) => line.startsWith('muted:removed local branch'))).toBe(true);
  });

  it('force mode passes --force to git worktree remove', async () => {
    process.env['SCRUMLORD_PIPELINE_CLEANUP'] = 'force';
    const { runner, calls } = recordingRunner(() => ok());
    const { log } = recordingLog();
    await cleanupWorktreeAfterMerge({
      worktree: '/scratch/worktrees/task',
      branch: 'task/abc12345',
      projectRoot: '/scratch/project',
      runner,
      log,
    });
    expect(calls[0]!.command).toContain('--force');
  });

  it('retains the worktree and logs a warning when git refuses removal', async () => {
    process.env['SCRUMLORD_PIPELINE_CLEANUP'] = 'remove';
    const { runner } = recordingRunner((joined) => {
      if (joined.startsWith('git worktree remove')) {
        return fail('worktree contains uncommitted changes');
      }
      return ok();
    });
    const { log, lines } = recordingLog();
    await cleanupWorktreeAfterMerge({
      worktree: '/scratch/worktrees/task',
      branch: 'task/abc12345',
      projectRoot: '/scratch/project',
      runner,
      log,
    });
    expect(lines.some((line) => line.includes('worktree retained'))).toBe(true);
  });

  it('skips when the worktree is the project root (no-worktree mode)', async () => {
    process.env['SCRUMLORD_PIPELINE_CLEANUP'] = 'remove';
    const { runner, calls } = recordingRunner(() => ok());
    const { log } = recordingLog();
    await cleanupWorktreeAfterMerge({
      worktree: '/scratch/project',
      branch: 'task/abc12345',
      projectRoot: '/scratch/project',
      runner,
      log,
    });
    expect(calls).toEqual([]);
  });

  it('warns and no-ops on an unknown CLEANUP value', async () => {
    process.env['SCRUMLORD_PIPELINE_CLEANUP'] = 'bogus';
    const { runner, calls } = recordingRunner(() => ok());
    const { log, lines } = recordingLog();
    await cleanupWorktreeAfterMerge({
      worktree: '/scratch/worktrees/task',
      branch: 'task/abc12345',
      projectRoot: '/scratch/project',
      runner,
      log,
    });
    expect(calls).toEqual([]);
    expect(lines.some((line) => line.includes('unknown SCRUMLORD_PIPELINE_CLEANUP=bogus'))).toBe(
      true,
    );
  });
});
