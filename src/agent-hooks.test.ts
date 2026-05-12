import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupAgentHooks } from './agent-hooks';
import { ScrumlordError } from './errors';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-agent-hooks-'));
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

const expectRejection = async (
  promise: Promise<unknown>,
  message: string | typeof ScrumlordError,
) => {
  try {
    await promise;
    throw new Error('Expected promise to reject.');
  } catch (error) {
    if (typeof message === 'string') {
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty('message', expect.stringContaining(message));
    } else {
      expect(error).toBeInstanceOf(message);
    }
  }
};

describe('setupAgentHooks', () => {
  it('writes Bun-based global Claude and Codex hook configuration', async () => {
    const root = await temporaryDirectory();
    const home = await temporaryDirectory();

    const result = await setupAgentHooks(root, { homeDirectory: home });

    expect(result.wrapperPath).toBe(join(home, '.scrumlord/hooks/scrumlord-agent-hook.ts'));
    expect(result.claude.changed).toBe(true);
    expect(result.codex.changed).toBe(true);

    const wrapper = await Bun.file(result.wrapperPath).text();
    expect(wrapper).toContain("Bun.which('tasks')");
    expect(wrapper).toContain('payloadCwdFromInput');
    expect(wrapper).toContain('process.cwd()');
    expect(wrapper).not.toContain(root);
    expect(wrapper).toContain('SCRUMLORD_DEBUG');
    expect(wrapper).toContain('UserPromptSubmit');
    expect(wrapper).toContain('forwardStdout');

    const claude = await Bun.file(join(home, '.claude/settings.json')).json();
    expect(JSON.stringify(claude)).toContain('PostToolUse');
    expect(JSON.stringify(claude)).toContain('ExitPlanMode');
    expect(JSON.stringify(claude)).toContain('Bash');
    expect(JSON.stringify(claude)).toContain('UserPromptSubmit');
    expect(JSON.stringify(claude)).toContain('bun run');

    const codexConfiguration = await Bun.file(join(home, '.codex/config.toml')).text();
    expect(codexConfiguration).toContain('[features]');
    expect(codexConfiguration).toContain('codex_hooks = true');
    const codexHooks = await Bun.file(join(home, '.codex/hooks.json')).json();
    expect(JSON.stringify(codexHooks)).toContain('Stop');
    expect(JSON.stringify(codexHooks)).toContain('UserPromptSubmit');

    const secondRun = await setupAgentHooks(root, { homeDirectory: home });
    expect(secondRun.claude.changed).toBe(false);
    expect(secondRun.codex.changed).toBe(false);

    const claudeOnly = await setupAgentHooks(root, { providers: ['claude'], homeDirectory: home });
    expect(claudeOnly.claude.skipped).toBe(false);
    expect(claudeOnly.codex).toEqual({
      configurationPath: join(home, '.codex/config.toml'),
      hooksPath: join(home, '.codex/hooks.json'),
      changed: false,
      skipped: true,
    });
  });

  it('updates existing Codex feature configuration shapes', async () => {
    const root = await temporaryDirectory();
    const falseRoot = await temporaryDirectory();
    await mkdir(join(falseRoot, '.codex'), { recursive: true });
    await Bun.write(join(falseRoot, '.codex/config.toml'), 'codex_hooks = false\n');
    const falseResult = await setupAgentHooks(root, { homeDirectory: falseRoot });
    expect(falseResult.codex.changed).toBe(true);
    expect(await Bun.file(join(falseRoot, '.codex/config.toml')).text()).toContain(
      'codex_hooks = true',
    );

    const featuresRoot = await temporaryDirectory();
    await mkdir(join(featuresRoot, '.codex'), { recursive: true });
    await Bun.write(join(featuresRoot, '.codex/config.toml'), '[features]\nother = true\n');
    const featuresResult = await setupAgentHooks(root, { homeDirectory: featuresRoot });
    expect(featuresResult.codex.changed).toBe(true);
    expect(await Bun.file(join(featuresRoot, '.codex/config.toml')).text()).toContain(
      '[features]\ncodex_hooks = true',
    );
  });

  it('fails clearly for invalid hook JSON', async () => {
    const root = await temporaryDirectory();
    const invalidRoot = await temporaryDirectory();
    await mkdir(join(invalidRoot, '.claude'), { recursive: true });
    await Bun.write(join(invalidRoot, '.claude/settings.json'), '{');
    await expectRejection(setupAgentHooks(root, { homeDirectory: invalidRoot }), ScrumlordError);

    const nonObjectRoot = await temporaryDirectory();
    await mkdir(join(nonObjectRoot, '.claude'), { recursive: true });
    await Bun.write(join(nonObjectRoot, '.claude/settings.json'), '[]');
    await expectRejection(
      setupAgentHooks(root, { homeDirectory: nonObjectRoot }),
      'Hook configuration must be a JSON object',
    );
  });
});
