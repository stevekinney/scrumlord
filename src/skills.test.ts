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
    ]);
    expect(existsSync(join(root, '.agents/skills/tasks/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.cursor/rules/tasks.md'))).toBe(false);
    const codexSkill = await Bun.file(join(root, '.agents/skills/tasks/SKILL.md')).text();
    const claudeSkill = await Bun.file(join(root, '.claude/skills/tasks/SKILL.md')).text();
    expect(codexSkill).toStartWith('---\nname: tasks\n');
    expect(codexSkill).toContain('description: Use this skill when inspecting');
    expect(codexSkill).toContain('---\n\n# Tasks CLI');
    expect(claudeSkill).toStartWith('---\nname: tasks\n');
    expect(claudeSkill).toContain('---\n\n# Tasks CLI');
    expect(claudeSkill).toContain('tasks init');
    expect(claudeSkill).toContain('tasks peek');
    expect(claudeSkill).toContain('tasks current');
    expect(claudeSkill).toContain('tasks remaining');
    expect(claudeSkill).toContain('Scrumlord priorities are only `1`, `2`, and `3`');
    expect(claudeSkill).toContain('build a candidate graph');
    expect(claudeSkill).toContain('Treat dependency language as graph data');
    expect(claudeSkill).toContain('do not fire many `tasks create` commands in parallel');
    expect(claudeSkill).toContain('If no dependency edges exist, say that explicitly');
    expect(claudeSkill).toContain('Setting a branch moves a `draft` or `ready` task');
    expect(claudeSkill).toContain('tasks update');
    expect(claudeSkill).toContain('tasks pr --sync --quiet');
    expect(claudeSkill).toContain('Do not store worktree paths');
    expect(claudeSkill).toContain('If a task has a `plan`, read that plan file');
    expect(claudeSkill).toContain('tasks session');
    expect(claudeSkill).toContain('tasks progress list');
    expect(claudeSkill).toContain('tasks progress add');
    expect(claudeSkill).toContain('tasks start');
    expect(claudeSkill).toContain('tasks setup --agent-hooks');
    expect(claudeSkill).toContain('project_unresolved');
    expect(claudeSkill).toContain('gh_not_found');
    expect(claudeSkill).toContain('pull_request_not_found');
    expect(claudeSkill).toContain('tasks pr');
    expect(claudeSkill).toContain('readyToMerge');
    expect(claudeSkill).toContain('tasks pr --comments');
  });
});
