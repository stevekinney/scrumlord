import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrumlordError } from './errors';
import { setupSubagents, subagentPaths } from './subagents';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-subagents-'));
  temporaryDirectories.push(directory);
  return directory;
};

const which =
  (installed: string[]) =>
  (executable: string): string | null =>
    installed.includes(executable) ? `/bin/${executable}` : null;

const expectRejectsWithScrumlordError = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
    throw new Error('Expected promise to reject.');
  } catch (error) {
    expect(error).toBeInstanceOf(ScrumlordError);
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('setupSubagents', () => {
  it('writes local Codex and Claude subagents with skills and Claude allow rules', async () => {
    const root = await temporaryDirectory();
    const home = await temporaryDirectory();

    const result = await setupSubagents(root, {
      target: '--all',
      homeDirectory: home,
      which: which(['codex', 'claude']),
    });

    expect(result.scope).toBe('local');
    expect(result.providers.map((provider) => provider.provider)).toEqual(['codex', 'claude']);
    expect(result.skills.map((skill) => skill.provider)).toEqual(['codex', 'claude']);
    expect(result.warnings).toEqual([]);

    const codexPath = join(root, '.codex/agents/scrumlord-task-manager.toml');
    const claudePath = join(root, '.claude/agents/scrumlord-task-manager.md');
    expect(result.providers.map((provider) => provider.path)).toEqual([codexPath, claudePath]);
    expect(existsSync(join(root, '.agents/skills/tasks/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.claude/skills/tasks/SKILL.md'))).toBe(true);

    const codex = await Bun.file(codexPath).text();
    expect(codex).toContain('sandbox_mode = "workspace-write"');
    expect(codex).toContain('which tasks');
    expect(codex).toContain('tasks setup status');
    expect(codex).toContain('tasks add-blocker');
    expect(codex).toContain('build a candidate graph');
    expect(codex).toContain('Scrumlord priorities are only');
    expect(codex).toContain('do not fire many `tasks create` commands in parallel');
    expect(codex).toContain('Never edit `tmp/tasks.db` directly.');
    expect(codex).toContain(join(root, '.agents/skills/tasks/SKILL.md'));

    const claude = await Bun.file(claudePath).text();
    expect(claude).toContain('tools: Read, Grep, Glob, Bash');
    expect(claude).toContain('permissionMode: default');
    expect(claude).toContain('Scrumlord tasks CLI is not available in PATH');
    expect(claude).toContain('tasks list');
    expect(claude).toContain('tasks setup-subagents');
    expect(claude).toContain('if there are no dependency edges, say that explicitly');

    const settings = await Bun.file(join(root, '.claude/settings.local.json')).json();
    expect(settings.permissions.allow).toContain('Bash(tasks:*)');
    expect(settings.permissions.allow).toContain('Bash(which tasks:*)');

    const secondRun = await setupSubagents(root, {
      target: '--all',
      homeDirectory: home,
      which: which(['codex', 'claude']),
    });
    expect(secondRun.providers.every((provider) => !provider.changed)).toBe(true);
    expect(secondRun.skills.every((skill) => !skill.changed)).toBe(true);
    expect(
      secondRun.providers.find((provider) => provider.provider === 'claude')?.settingsChanged,
    ).toBe(false);
  });

  it('uses installed providers by default and can skip skill writes for setup orchestration', async () => {
    const root = await temporaryDirectory();
    const home = await temporaryDirectory();

    const result = await setupSubagents(root, {
      homeDirectory: home,
      which: which(['codex']),
      writeSkills: false,
    });

    expect(result.providers.map((provider) => provider.provider)).toEqual(['codex']);
    expect(result.skills).toEqual([]);
    expect(existsSync(join(root, '.agents/skills/tasks/SKILL.md'))).toBe(false);
  });

  it('writes global subagents and global skill copies', async () => {
    const root = await temporaryDirectory();
    const home = await temporaryDirectory();

    const result = await setupSubagents(root, {
      target: 'claude',
      scope: 'global',
      homeDirectory: home,
      which: which(['claude']),
    });

    expect(result.providers).toEqual([
      {
        provider: 'claude',
        path: join(home, '.claude/agents/scrumlord-task-manager.md'),
        changed: true,
        settingsPath: join(home, '.claude/settings.json'),
        settingsChanged: true,
      },
    ]);
    expect(result.skills).toEqual([
      { provider: 'claude', path: join(home, '.claude/skills/tasks/SKILL.md'), changed: true },
    ]);
  });

  it('returns a warning when no provider is installed by default', async () => {
    const root = await temporaryDirectory();

    const result = await setupSubagents(root, { which: which([]) });

    expect(result.providers).toEqual([]);
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual(['no_agent_provider_cli_found']);
  });

  it('fails clearly when a requested provider is missing or settings are invalid', async () => {
    const root = await temporaryDirectory();

    await expectRejectsWithScrumlordError(
      setupSubagents(root, { target: 'codex', which: which([]) }),
    );

    await mkdir(join(root, '.claude'), { recursive: true });
    await Bun.write(join(root, '.claude/settings.local.json'), '[]');
    await expectRejectsWithScrumlordError(
      setupSubagents(root, { target: 'claude', which: which(['claude']) }),
    );

    await Bun.write(join(root, '.claude/settings.local.json'), '{');
    await expectRejectsWithScrumlordError(
      setupSubagents(root, { target: 'claude', which: which(['claude']) }),
    );
  });

  it('exposes deterministic path helpers for status reporting', async () => {
    expect(subagentPaths.providerSkillPath('/project', '/home/me', 'codex', 'local')).toBe(
      '/project/.agents/skills/tasks/SKILL.md',
    );
    expect(subagentPaths.providerSkillPath('/project', '/home/me', 'claude', 'global')).toBe(
      '/home/me/.claude/skills/tasks/SKILL.md',
    );
    expect(subagentPaths.subagentPath('/project', '/home/me', 'codex', 'global')).toBe(
      '/home/me/.codex/agents/scrumlord-task-manager.toml',
    );
    expect(subagentPaths.claudeSettingsPath('/project', '/home/me', 'local')).toBe(
      '/project/.claude/settings.local.json',
    );
  });
});
