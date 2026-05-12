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

const claudeCommand = 'command -v tasks >/dev/null 2>&1 && tasks agent-hook claude || true';
const codexCommand = 'command -v tasks >/dev/null 2>&1 && tasks agent-hook codex || true';

describe('setupAgentHooks', () => {
  it('registers tasks agent-hook commands directly with no wrapper', async () => {
    const root = await temporaryDirectory();
    const home = await temporaryDirectory();

    const result = await setupAgentHooks(root, { homeDirectory: home });

    expect(result.claude.changed).toBe(true);
    expect(result.codex.changed).toBe(true);

    const claude = await Bun.file(join(home, '.claude/settings.json')).json();
    const serializedClaude = JSON.stringify(claude);
    expect(serializedClaude).toContain(claudeCommand);
    expect(serializedClaude).not.toContain('bun run');
    expect(serializedClaude).not.toContain('scrumlord-agent-hook.ts');
    expect(serializedClaude).toContain('PostToolUse');
    expect(serializedClaude).toContain('ExitPlanMode');
    expect(serializedClaude).toContain('Bash');
    expect(serializedClaude).toContain('UserPromptSubmit');
    expect(serializedClaude).toContain('Stop');
    expect(serializedClaude).toContain('SessionStart');

    const codexConfiguration = await Bun.file(join(home, '.codex/config.toml')).text();
    expect(codexConfiguration).toContain('[features]');
    expect(codexConfiguration).toContain('codex_hooks = true');

    const codexHooks = await Bun.file(join(home, '.codex/hooks.json')).json();
    const serializedCodex = JSON.stringify(codexHooks);
    expect(serializedCodex).toContain(codexCommand);
    expect(serializedCodex).not.toContain('bun run');
    expect(serializedCodex).toContain('Stop');
    expect(serializedCodex).toContain('UserPromptSubmit');

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

  it('migrates legacy wrapper-based hook commands in place', async () => {
    const root = await temporaryDirectory();
    const home = await temporaryDirectory();
    await mkdir(join(home, '.claude'), { recursive: true });
    const legacyWrapper = join(home, '.scrumlord/hooks/scrumlord-agent-hook.ts');
    const legacyClaudeCommand = `bun run "${legacyWrapper}" claude`;
    await Bun.write(
      join(home, '.claude/settings.json'),
      `${JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: legacyClaudeCommand, timeout: 10 }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await setupAgentHooks(root, { homeDirectory: home });
    expect(result.claude.changed).toBe(true);

    const claude = await Bun.file(join(home, '.claude/settings.json')).json();
    const serialized = JSON.stringify(claude);
    expect(serialized).toContain(claudeCommand);
    // Legacy command must be gone; migration replaces, not duplicates.
    expect(serialized).not.toContain(legacyClaudeCommand);
    expect(serialized).not.toContain('scrumlord-agent-hook.ts');

    // Idempotent: second run should not change anything.
    const secondRun = await setupAgentHooks(root, { homeDirectory: home });
    expect(secondRun.claude.changed).toBe(false);
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
