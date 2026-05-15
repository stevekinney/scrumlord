import { describe, expect, it } from 'bun:test';
import { runTasksCli } from './cli-runner';

const errorCode = async (argv: string[]): Promise<string> => {
  const result = await runTasksCli(argv);
  return JSON.parse(result.stderr).error.code;
};

describe('removed CLI commands return unknown_command', () => {
  it('rejects set-status', async () => {
    expect(await errorCode(['set-status', 'task-id', 'completed'])).toBe('unknown_command');
  });

  it('rejects set-branch', async () => {
    expect(await errorCode(['set-branch', 'task-id', 'feature/x'])).toBe('unknown_command');
  });

  it('rejects clear-branch', async () => {
    expect(await errorCode(['clear-branch', 'task-id'])).toBe('unknown_command');
  });

  it('rejects set-plan', async () => {
    expect(await errorCode(['set-plan', 'task-id', 'tmp/plans/a.md'])).toBe('unknown_command');
  });

  it('rejects clear-plan', async () => {
    expect(await errorCode(['clear-plan', 'task-id'])).toBe('unknown_command');
  });

  it('rejects set-session', async () => {
    expect(await errorCode(['set-session', 'task-id', 'codex', 'sess'])).toBe('unknown_command');
  });

  it('rejects clear-session', async () => {
    expect(await errorCode(['clear-session', 'task-id'])).toBe('unknown_command');
  });

  it('rejects add-progress', async () => {
    expect(await errorCode(['add-progress', '--message', 'hi'])).toBe('unknown_command');
  });

  it('rejects sync-git-status with migration hint in message', async () => {
    const result = await runTasksCli(['sync-git-status']);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe('unknown_command');
    expect(error.message).toContain('tasks pr --sync');
    expect(error.message).toContain('tasks setup --git-hooks');
  });
});

describe('new command validation', () => {
  it('rejects invalid progress subcommand', async () => {
    expect(await errorCode(['progress', 'nope'])).toBe('invalid_progress_subcommand');
  });

  it('rejects missing progress subcommand', async () => {
    expect(await errorCode(['progress'])).toBe('missing_subcommand');
  });

  it('rejects invalid clear property', async () => {
    expect(await errorCode(['clear', 'nonsense'])).toBe('invalid_clear_property');
  });

  it('rejects progress list --message flag', async () => {
    expect(await errorCode(['progress', 'list', '--message', 'hi'])).toBe('invalid_progress_flag');
  });

  it('rejects pr --quiet without --sync', async () => {
    expect(await errorCode(['pr', '--quiet'])).toBe('pr_flag_conflict');
  });

  it('rejects pr --sync --url', async () => {
    expect(await errorCode(['pr', '--sync', '--url'])).toBe('pr_flag_conflict');
  });
});
