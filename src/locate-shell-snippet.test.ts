import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASKS_START_SHELL_SNIPPET } from './cli-locate-command';

const bash = Bun.which('bash');

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-locate-shell-'));
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

describe('TASKS_START_SHELL_SNIPPET', () => {
  it('contains the tasks-start function', () => {
    expect(TASKS_START_SHELL_SNIPPET).toContain('tasks-start()');
  });

  it('uses `command tasks` to bypass shell function aliases', () => {
    expect(TASKS_START_SHELL_SNIPPET).toContain('command tasks start');
    expect(TASKS_START_SHELL_SNIPPET).toContain('command tasks locate');
  });

  it('ends with a newline', () => {
    expect(TASKS_START_SHELL_SNIPPET).toMatch(/\n$/);
  });
});

describe('tasks-start — shell wrapper integration', () => {
  it.skipIf(!bash)('cds into the worktree the stub reports after start', async () => {
    const testRoot = await temporaryDirectory();
    // Resolve symlinks for macOS /var → /private/var compatibility.
    const realTestRoot = await realpath(testRoot);
    const wtDir = join(realTestRoot, 'wt with spaces');
    await mkdir(wtDir, { recursive: true });

    const stubDir = join(testRoot, 'stub-bin');
    await mkdir(stubDir, { recursive: true });
    const stubScript = join(stubDir, 'tasks');
    // `tasks start ...` exits 0 and prints nothing; `tasks locate ...` prints the path.
    await writeFile(
      stubScript,
      `#!/bin/bash\nif [ "$1" = "locate" ]; then printf '%s\\n' "${wtDir.replace(/"/g, '\\"')}"; fi\nexit 0\n`,
    );
    await chmod(stubScript, 0o755);

    const snippetFile = join(testRoot, 'snippet.sh');
    await writeFile(snippetFile, TASKS_START_SHELL_SNIPPET);

    const script = [
      `source '${snippetFile}'`,
      'tasks-start current',
      'status=$?',
      'printf \'%s\\n\' "$PWD"',
      'exit "$status"',
    ].join('\n');

    const subprocess = Bun.spawn(['bash', '-c', script], {
      cwd: testRoot,
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);

    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];

    expect(exitCode).toBe(0);
    expect(lastLine).toBe(wtDir);
  });

  it.skipIf(!bash)('stays put when locate reports no worktree', async () => {
    const testRoot = await temporaryDirectory();
    const realTestRoot = await realpath(testRoot);

    const stubDir = join(testRoot, 'stub-bin');
    await mkdir(stubDir, { recursive: true });
    const stubScript = join(stubDir, 'tasks');
    // `tasks start` succeeds; `tasks locate` fails (no worktree) → no cd.
    await writeFile(stubScript, '#!/bin/bash\nif [ "$1" = "locate" ]; then exit 1; fi\nexit 0\n');
    await chmod(stubScript, 0o755);

    const snippetFile = join(testRoot, 'snippet.sh');
    await writeFile(snippetFile, TASKS_START_SHELL_SNIPPET);

    const script = [
      `source '${snippetFile}'`,
      'tasks-start current',
      'status=$?',
      'printf \'%s\\n\' "$PWD"',
      'exit "$status"',
    ].join('\n');

    const subprocess = Bun.spawn(['bash', '-c', script], {
      cwd: testRoot,
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);

    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];

    expect(exitCode).toBe(0);
    expect(lastLine).toBe(realTestRoot);
  });
});
