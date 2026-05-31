import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TELEPORT_SHELL_SNIPPET } from './cli-teleport-command';

const bash = Bun.which('bash');

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-teleport-shell-'));
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

describe('TELEPORT_SHELL_SNIPPET', () => {
  it('contains the tasks-teleport function', () => {
    expect(TELEPORT_SHELL_SNIPPET).toContain('tasks-teleport()');
  });

  it('uses `command tasks teleport` to bypass shell function aliases', () => {
    expect(TELEPORT_SHELL_SNIPPET).toContain('command tasks teleport');
  });

  it('has the tt alias line commented out', () => {
    const aliasLine = TELEPORT_SHELL_SNIPPET.split('\n').find((line) => line.includes('alias tt='));
    expect(aliasLine).toBeDefined();
    expect(aliasLine!.trimStart()).toMatch(/^#/);
  });

  it('ends with a newline', () => {
    expect(TELEPORT_SHELL_SNIPPET).toMatch(/\n$/);
  });
});

describe('tasks teleport — shell wrapper integration', () => {
  it.skipIf(!bash)('tasks-teleport cd into the destination on success', async () => {
    const testRoot = await temporaryDirectory();
    // Resolve symlinks for macOS /var → /private/var compatibility.
    const realTestRoot = await realpath(testRoot);
    const wtDir = join(realTestRoot, 'wt with spaces');
    await mkdir(wtDir, { recursive: true });

    const stubDir = join(testRoot, 'stub-bin');
    await mkdir(stubDir, { recursive: true });
    const stubScript = join(stubDir, 'tasks');
    await writeFile(
      stubScript,
      `#!/bin/bash\nprintf '%s\\n' "${wtDir.replace(/"/g, '\\"')}"\nexit 0\n`,
    );
    await chmod(stubScript, 0o755);

    const snippetFile = join(testRoot, 'snippet.sh');
    await writeFile(snippetFile, TELEPORT_SHELL_SNIPPET);

    const script = [
      `source '${snippetFile}'`,
      'tasks-teleport current',
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

  it.skipIf(!bash)('tasks-teleport returns exit code 1 when the stub fails', async () => {
    const testRoot = await temporaryDirectory();
    const realTestRoot = await realpath(testRoot);

    const stubDir = join(testRoot, 'stub-bin');
    await mkdir(stubDir, { recursive: true });
    const stubScript = join(stubDir, 'tasks');
    await writeFile(stubScript, '#!/bin/bash\nexit 1\n');
    await chmod(stubScript, 0o755);

    const snippetFile = join(testRoot, 'snippet.sh');
    await writeFile(snippetFile, TELEPORT_SHELL_SNIPPET);

    const script = [
      `source '${snippetFile}'`,
      'tasks-teleport current',
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

    expect(exitCode).toBe(1);
    expect(lastLine).toBe(realTestRoot);
  });

  it.skipIf(!bash)(
    'tasks-teleport returns exit code 1 when stub exits 0 with empty stdout',
    async () => {
      const testRoot = await temporaryDirectory();
      const realTestRoot = await realpath(testRoot);

      const stubDir = join(testRoot, 'stub-bin');
      await mkdir(stubDir, { recursive: true });
      const stubScript = join(stubDir, 'tasks');
      await writeFile(stubScript, '#!/bin/bash\nprintf ""\nexit 0\n');
      await chmod(stubScript, 0o755);

      const snippetFile = join(testRoot, 'snippet.sh');
      await writeFile(snippetFile, TELEPORT_SHELL_SNIPPET);

      const script = [
        `source '${snippetFile}'`,
        'tasks-teleport current',
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

      expect(exitCode).toBe(1);
      expect(lastLine).toBe(realTestRoot);
    },
  );
});

describe('tasks start — shell wrapper integration', () => {
  it.skipIf(!bash)(
    'tasks-start cds into the worktree resolved from the last argument',
    async () => {
      const testRoot = await temporaryDirectory();
      // Resolve symlinks for macOS /var → /private/var compatibility.
      const realTestRoot = await realpath(testRoot);
      const wtDir = join(realTestRoot, 'wt with spaces');
      await mkdir(wtDir, { recursive: true });

      const stubDir = join(testRoot, 'stub-bin');
      await mkdir(stubDir, { recursive: true });
      // The stub answers both subcommands the wrapper invokes: `start` exits 0
      // with no output, `teleport` prints the worktree path. It also records the
      // arguments `teleport` was called with so we can assert the wrapper passed
      // the *last* positional (the task id), exercising the portable last-arg
      // extraction in TELEPORT_SHELL_SNIPPET.
      const argsLog = join(testRoot, 'teleport-args.txt');
      const stubScript = join(stubDir, 'tasks');
      await writeFile(
        stubScript,
        `#!/bin/bash\nif [ "$1" = "teleport" ]; then\n  printf '%s\\n' "$2" > "${argsLog.replace(/"/g, '\\"')}"\n  printf '%s\\n' "${wtDir.replace(/"/g, '\\"')}"\nfi\nexit 0\n`,
      );
      await chmod(stubScript, 0o755);

      const snippetFile = join(testRoot, 'snippet.sh');
      await writeFile(snippetFile, TELEPORT_SHELL_SNIPPET);

      const script = [
        `source '${snippetFile}'`,
        'tasks-start --cli claude abc12345',
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

      // The wrapper must pass the trailing task id (not the flags) to teleport…
      const recordedArgs = await Bun.file(argsLog).text();
      expect(recordedArgs.trim()).toBe('abc12345');
      // …and end up inside the resolved worktree, preserving the success exit code.
      expect(exitCode).toBe(0);
      expect(lastLine).toBe(wtDir);
    },
  );

  it.skipIf(!bash)(
    'tasks-start stays put and preserves status when no worktree exists',
    async () => {
      const testRoot = await temporaryDirectory();
      const realTestRoot = await realpath(testRoot);

      const stubDir = join(testRoot, 'stub-bin');
      await mkdir(stubDir, { recursive: true });
      // `start` exits non-zero and `teleport` finds nothing → the wrapper must not
      // cd, and must propagate the `start` exit status.
      const stubScript = join(stubDir, 'tasks');
      await writeFile(
        stubScript,
        '#!/bin/bash\nif [ "$1" = "teleport" ]; then exit 1; fi\nexit 3\n',
      );
      await chmod(stubScript, 0o755);

      const snippetFile = join(testRoot, 'snippet.sh');
      await writeFile(snippetFile, TELEPORT_SHELL_SNIPPET);

      const script = [
        `source '${snippetFile}'`,
        'tasks-start abc12345',
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

      expect(exitCode).toBe(3);
      expect(lastLine).toBe(realTestRoot);
    },
  );
});
