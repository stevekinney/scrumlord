import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrumlordError } from './errors';
import { initializeProject } from './init';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-init-'));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('initializeProject', () => {
  it('creates the database, writes skills, and checks for managed hooks', async () => {
    const root = await workspaceRoot();
    const nested = join(root, 'packages', 'example');

    const result = await initializeProject({ cwd: nested });

    expect(result.projectRoot).toBe(root);
    expect(result.databasePath).toBe(join(root, 'tmp', 'tasks.db'));
    expect(existsSync(result.databasePath)).toBe(true);
    expect(result.skills.map((skill) => skill.target)).toEqual(['codex', 'claude']);
    expect(existsSync(join(root, '.agents/skills/tasks/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.claude/skills/tasks/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.cursor/rules/tasks.md'))).toBe(false);
    expect(result.gitHooks).toEqual({
      configurationPath: null,
      changed: false,
      hooks: [],
      install: null,
    });
  });

  it('can initialize only the database when optional boilerplate is disabled', async () => {
    const root = await workspaceRoot();

    const result = await initializeProject({ cwd: root, skills: false, gitHooks: false });

    expect(existsSync(result.databasePath)).toBe(true);
    expect(result.skills).toEqual([]);
    expect(result.gitHooks).toBeNull();
    expect(existsSync(join(root, '.agents/skills/tasks/SKILL.md'))).toBe(false);
  });

  it('does not create a database when project root resolution fails', async () => {
    const root = await temporaryDirectory();

    try {
      await initializeProject({ cwd: root });
      throw new Error('Expected initialization to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ScrumlordError);
      if (error instanceof ScrumlordError) {
        expect(error.code).toBe('project_root_not_found');
      }
    }
    expect(existsSync(join(root, 'tmp', 'tasks.db'))).toBe(false);
  });
});
