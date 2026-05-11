import { describe, expect, it } from 'bun:test';
import { runCommand } from './command-runner';

describe('runCommand', () => {
  it('runs commands with Bun and captures output', async () => {
    const result = await runCommand(
      [process.execPath, '-e', 'console.log("ok"); console.error("warn");'],
      import.meta.dir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok\n');
    expect(result.stderr).toBe('warn\n');
  });

  it('returns a failed command result when the executable is missing', async () => {
    const result = await runCommand(['scrumlord-command-that-does-not-exist'], import.meta.dir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Executable not found');
  });
});
