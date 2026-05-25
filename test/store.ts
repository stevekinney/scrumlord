import { expect } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/command-runner.js';
import { runCommand as defaultRunner } from '../src/command-runner.js';
import { createTaskStore, type CreateTaskStoreOptions } from '../src/database-open.js';
import type { TaskStore } from '../src/types.js';

/**
 * Awaits a promise expected to reject, asserting on the `ScrumlordError` code or
 * a message substring. Used instead of `await expect(...).rejects` because the
 * type-aware linter does not recognize bun:test's `rejects` matcher as thenable.
 */
export const expectRejection = async (
  promise: Promise<unknown>,
  match: { code: string } | { message: string },
): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    if ('code' in match) {
      expect((error as { code?: string }).code).toBe(match.code);
    } else {
      expect(String((error as { message?: string }).message)).toContain(match.message);
    }
    return;
  }
  throw new Error('Expected the promise to reject, but it resolved.');
};

/**
 * Wraps a real {@link CommandRunner} so that `gh repo view` resolves to a
 * deterministic `owner/repo` name even in test temp directories that have no
 * GitHub remote. Every other command falls through to the real runner so git
 * operations against the temp repo still work.
 */
const testProjectRunner = (nameWithOwner: string, base: CommandRunner): CommandRunner => {
  return async (command, cwd): Promise<CommandResult> => {
    const joined = command.join(' ');
    if (joined.startsWith('gh repo view')) {
      return { exitCode: 0, stdout: `${nameWithOwner}\n`, stderr: '' };
    }
    if (joined === 'git remote get-url origin') {
      return { exitCode: 0, stdout: `https://github.com/${nameWithOwner}.git\n`, stderr: '' };
    }
    return base(command, cwd);
  };
};

export type CreateTestStoreOptions = CreateTaskStoreOptions & {
  /** The `owner/repo` the synthetic `gh repo view` should report. */
  nameWithOwner?: string;
};

/**
 * Creates an isolated, project-scoped {@link TaskStore} for tests. The shared
 * database lives under a throwaway home directory (so tests never touch the
 * real `~/.scrumlord/tasks.db`), and the project resolves to a deterministic
 * name regardless of the temp repo's actual remotes. Pass distinct
 * `nameWithOwner` values to exercise cross-project isolation in a single home.
 */
export const createTestStore = async (options: CreateTestStoreOptions = {}): Promise<TaskStore> => {
  // Prefer the per-test SCRUMLORD_HOME set by test/setup.ts so multiple stores
  // created within one test share a database; fall back to a throwaway home.
  const homeDirectory =
    options.homeDirectory ??
    process.env['SCRUMLORD_HOME'] ??
    (await mkdtemp(join(tmpdir(), 'scrumlord-home-')));
  const nameWithOwner = options.nameWithOwner ?? 'octocat/example';
  const runner = testProjectRunner(nameWithOwner, options.runner ?? defaultRunner);
  const { nameWithOwner: _ignored, ...storeOptions } = options;
  return createTaskStore({ ...storeOptions, homeDirectory, runner });
};
