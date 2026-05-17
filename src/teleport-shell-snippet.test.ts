import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TELEPORT_SHELL_SNIPPET } from './cli-teleport-command';

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
  it('tasks-teleport cd into the destination on success', async () => {
    const bash = Bun.which('bash');
    if (!bash) {
      console.log('Skipping shell wrapper test: bash not found');
      return;
    }

    const testRoot = await temporaryDirectory();
    // Resolve symlinks for macOS /var → /private/var compatibility.
    const realpathProc = Bun.spawn(['realpath', testRoot], { stdout: 'pipe', stderr: 'pipe' });
    const realpathText = await new Response(realpathProc.stdout).text();
    const realTestRoot = realpathText.trim() || testRoot;
    const wtDir = join(realTestRoot, 'wt with spaces');
    await mkdir(wtDir, { recursive: true });

    const stubDir = join(testRoot, 'stub-bin');
    await mkdir(stubDir, { recursive: true });
    const stubScript = join(stubDir, 'tasks');
    await writeFile(stubScript, `#!/bin/bash\nprintf '%s\\n' '${wtDir}'\nexit 0\n`);
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

  it('tasks-teleport returns exit code 1 when the stub fails', async () => {
    const bash = Bun.which('bash');
    if (!bash) return;

    const testRoot = await temporaryDirectory();
    // Resolve symlinks so the shell's $PWD matches (macOS /var → /private/var).
    const realpathProc = Bun.spawn(['realpath', testRoot], { stdout: 'pipe', stderr: 'pipe' });
    const realpathText = await new Response(realpathProc.stdout).text();
    const realTestRoot = realpathText.trim() || testRoot;

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

  it('tasks-teleport returns exit code 1 when stub exits 0 with empty stdout', async () => {
    const bash = Bun.which('bash');
    if (!bash) return;

    const testRoot = await temporaryDirectory();
    const realpathProc = Bun.spawn(['realpath', testRoot], { stdout: 'pipe', stderr: 'pipe' });
    const realpathText = await new Response(realpathProc.stdout).text();
    const realTestRoot = realpathText.trim() || testRoot;

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
  });
});
