import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSkills } from './skills';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-skills-'));
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

describe('setupSkills', () => {
  it('writes requested agent instruction files', async () => {
    const root = await temporaryDirectory();

    expect(await setupSkills(root, 'codex')).toEqual([
      { target: 'codex', path: join(root, '.agents/skills/tasks/SKILL.md') },
    ]);
    expect(await setupSkills(root, '--all')).toEqual([
      { target: 'codex', path: join(root, '.agents/skills/tasks/SKILL.md') },
      { target: 'claude', path: join(root, '.claude/skills/tasks/SKILL.md') },
      { target: 'cursor', path: join(root, '.cursor/rules/tasks.md') },
    ]);
    expect(existsSync(join(root, '.agents/skills/tasks/SKILL.md'))).toBe(true);
    const cursorSkill = await Bun.file(join(root, '.cursor/rules/tasks.md')).text();
    expect(cursorSkill).toContain('tasks init');
    expect(cursorSkill).toContain('tasks next');
    expect(cursorSkill).toContain('tasks current');
    expect(cursorSkill).toContain('tasks remaining');
    expect(cursorSkill).toContain('Scrumlord priorities are only `1`, `2`, and `3`');
    expect(cursorSkill).toContain('build a candidate graph');
    expect(cursorSkill).toContain('Treat dependency language as graph data');
    expect(cursorSkill).toContain('do not fire many `tasks create` commands in parallel');
    expect(cursorSkill).toContain('If no dependency edges exist, say that explicitly');
    expect(cursorSkill).toContain('Setting a branch moves a `draft` or `ready` task');
    expect(cursorSkill).toContain('task ID can omit it');
    expect(cursorSkill).toContain('tasks set-branch [task-id]');
    expect(cursorSkill).toContain('tasks sync-git-status --quiet');
    expect(cursorSkill).toContain('Do not store worktree paths');
    expect(cursorSkill).toContain('If a task has a `plan`, read that plan file');
    expect(cursorSkill).toContain('tasks session [task-id]');
    expect(cursorSkill).toContain('tasks progress [task-id]');
    expect(cursorSkill).toContain('tasks add-progress [task-id]');
    expect(cursorSkill).toContain('tasks start --cli codex');
    expect(cursorSkill).toContain('tasks resume');
    expect(cursorSkill).toContain('tasks setup-agent-hooks');
    expect(cursorSkill).toContain('project_root_not_found');
    expect(cursorSkill).toContain('gh_not_found');
    expect(cursorSkill).toContain('pull_request_not_found');
    expect(cursorSkill).toContain('tasks pr status');
    expect(cursorSkill).toContain('readyToMerge');
    expect(cursorSkill).toContain('tasks comments');
    expect(cursorSkill).toContain('tasks ci');
  });
});
