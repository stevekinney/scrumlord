import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { generateBashCompletions, generateZshCompletions } from './completions';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-completions-cmd-'));
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

describe('tasks completions bash', () => {
  it('returns exit 0 and stdout equals generateBashCompletions()', async () => {
    const result = await runTasksCli(['completions', 'bash']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(generateBashCompletions());
    expect(result.stderr).toBe('');
  });
});

describe('tasks completions zsh', () => {
  it('returns exit 0 and stdout equals generateZshCompletions()', async () => {
    const result = await runTasksCli(['completions', 'zsh']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(generateZshCompletions());
    expect(result.stderr).toBe('');
  });
});

describe('tasks completions fish', () => {
  it('returns exit 1 with unsupported_shell error', async () => {
    const result = await runTasksCli(['completions', 'fish']);
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.error.code).toBe('unsupported_shell');
  });
});

describe('tasks completions (no positional)', () => {
  it('returns exit 1 with missing_argument error', async () => {
    const result = await runTasksCli(['completions']);
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.error.code).toBe('missing_argument');
  });
});

describe('tasks completions bash foo', () => {
  it('returns exit 1 with unexpected_argument error', async () => {
    const result = await runTasksCli(['completions', 'bash', 'foo']);
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.error.code).toBe('unexpected_argument');
  });
});

describe('tasks completions bash --path without --install', () => {
  it('returns exit 1 with path_requires_install error', async () => {
    const result = await runTasksCli(['completions', 'bash', '--path', '/tmp/x']);
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.error.code).toBe('path_requires_install');
  });
});

describe('tasks completions bash --force without --install', () => {
  it('returns exit 1 with force_requires_install error', async () => {
    const result = await runTasksCli(['completions', 'bash', '--force']);
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.error.code).toBe('force_requires_install');
  });
});

describe('tasks completions bash --install --path <file>', () => {
  it('writes the file, exits 0, stdout reports path, contents match generator', async () => {
    const dir = await temporaryDirectory();
    const filePath = join(dir, 'tasks');

    const result = await runTasksCli(['completions', 'bash', '--install', '--path', filePath], {
      environment: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(filePath);
    expect(existsSync(filePath)).toBe(true);
    const written = await Bun.file(filePath).text();
    expect(written).toBe(generateBashCompletions());
  });
});

describe('tasks completions bash --install --path existing-file (no --force)', () => {
  it('returns exit 1 with completion_file_exists and does not overwrite', async () => {
    const dir = await temporaryDirectory();
    const filePath = join(dir, 'tasks');
    await writeFile(filePath, 'original content', 'utf-8');

    const result = await runTasksCli(['completions', 'bash', '--install', '--path', filePath], {
      environment: {},
    });
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.error.code).toBe('completion_file_exists');
    const contents = await Bun.file(filePath).text();
    expect(contents).toBe('original content');
  });
});

describe('tasks completions bash --install --path existing-file --force', () => {
  it('overwrites the file and returns exit 0', async () => {
    const dir = await temporaryDirectory();
    const filePath = join(dir, 'tasks');
    await writeFile(filePath, 'old content', 'utf-8');

    const result = await runTasksCli(
      ['completions', 'bash', '--install', '--path', filePath, '--force'],
      { environment: {} },
    );
    expect(result.exitCode).toBe(0);
    const contents = await Bun.file(filePath).text();
    expect(contents).toBe(generateBashCompletions());
  });
});

describe('tasks completions zsh --install with XDG_DATA_HOME set', () => {
  it('writes to the expected default zsh path and shows fpath instructions', async () => {
    const dir = await temporaryDirectory();
    const expectedPath = join(dir, 'zsh', 'site-functions', '_tasks');

    const result = await runTasksCli(['completions', 'zsh', '--install'], {
      environment: { XDG_DATA_HOME: dir },
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(expectedPath)).toBe(true);
    const contents = await Bun.file(expectedPath).text();
    expect(contents).toBe(generateZshCompletions());
    expect(result.stdout).toContain(expectedPath);
    expect(result.stdout).toContain('fpath');
    expect(result.stdout).toContain('compinit');
  });
});

describe('tasks completions zsh --install with no env set', () => {
  it('returns exit 1 with no_install_path', async () => {
    const result = await runTasksCli(['completions', 'zsh', '--install'], {
      environment: {},
    });
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.error.code).toBe('no_install_path');
  });
});

describe('tasks help completions', () => {
  it('renders a help topic that mentions both shells and all flags', async () => {
    const result = await runTasksCli(['help', 'completions']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bash');
    expect(result.stdout).toContain('zsh');
    expect(result.stdout).toContain('--install');
    expect(result.stdout).toContain('--force');
    expect(result.stdout).toContain('--path');
  });
});

describe('tasks completions --help', () => {
  it('renders the completions help topic', async () => {
    const result = await runTasksCli(['completions', 'bash', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('completions');
  });
});

describe('end-to-end CLI wiring', () => {
  it('runTasksCli routes completions bash to the boundary handler', async () => {
    const result = await runTasksCli(['completions', 'bash'], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('#!/usr/bin/env bash');
  });

  it('runTasksCli routes completions zsh to the boundary handler', async () => {
    const result = await runTasksCli(['completions', 'zsh'], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('#compdef tasks');
  });
});

describe('tasks completions bash --install creates parent directories', () => {
  it('creates nested directories if needed', async () => {
    const dir = await temporaryDirectory();
    const filePath = join(dir, 'deeply', 'nested', 'tasks');

    const result = await runTasksCli(['completions', 'bash', '--install', '--path', filePath], {
      environment: {},
    });
    expect(result.exitCode).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });
});
