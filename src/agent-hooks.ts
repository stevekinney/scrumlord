import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ScrumlordError } from './errors.js';
import type { AgentProvider } from './types.js';

export type SetupAgentHooksResult = {
  wrapperPath: string;
  claude: {
    settingsPath: string;
    changed: boolean;
    skipped: boolean;
  };
  codex: {
    configurationPath: string;
    hooksPath: string;
    changed: boolean;
    skipped: boolean;
  };
};

export type SetupAgentHooksOptions = {
  providers?: readonly AgentProvider[];
};

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const readJsonObject = async (path: string): Promise<JsonObject> => {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    if (isRecord(parsed)) return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError(
      'agent_hooks_configuration_invalid',
      `Could not parse hook configuration ${path}: ${message}`,
    );
  }
  throw new ScrumlordError(
    'agent_hooks_configuration_invalid',
    `Hook configuration must be a JSON object: ${path}`,
  );
};

const writeJsonObject = async (path: string, value: JsonObject): Promise<void> => {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
};

const entryMatchesCommand = (entry: unknown, matcher: string | null, command: string): boolean => {
  if (!isRecord(entry) || !Array.isArray(entry['hooks'])) return false;
  const entryMatcher = typeof entry['matcher'] === 'string' ? entry['matcher'] : null;
  if (entryMatcher !== matcher) return false;
  return entry['hooks'].some((hook) => isRecord(hook) && hook['command'] === command);
};

const ensureHookEntry = (
  configuration: JsonObject,
  event: string,
  matcher: string | null,
  command: string,
): boolean => {
  const hooks = isRecord(configuration['hooks']) ? configuration['hooks'] : {};
  configuration['hooks'] = hooks;
  const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
  if (entries.some((entry) => entryMatchesCommand(entry, matcher, command))) return false;

  const entry: JsonObject = {
    hooks: [{ type: 'command', command, timeout: 10 }],
  };
  if (matcher) entry['matcher'] = matcher;
  entries.push(entry);
  hooks[event] = entries;
  return true;
};

const wrapperScript = (projectRoot: string): string => `#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = ${JSON.stringify(projectRoot)};
const provider = process.argv[2] ?? '';
const debug = Boolean(Bun.env.SCRUMLORD_DEBUG);
const skip = (reason) => {
  if (debug) console.error(\`scrumlord agent hook skipped: \${reason}\`);
  process.exit(0);
};

if (!provider) skip('missing provider');
if (!existsSync(join(projectRoot, 'tmp', 'tasks.db'))) skip('tmp/tasks.db does not exist');

const tasks = Bun.which('tasks');
if (!tasks) skip('tasks executable is not available');

const input = await Bun.stdin.text();
const hookEventNameFromInput = (raw) => {
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    for (const key of ['hook_event_name', 'hookEventName', 'event', 'eventName']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
  } catch {
    return null;
  }
  return null;
};
const forwardStdout = hookEventNameFromInput(input) === 'UserPromptSubmit';
const subprocess = Bun.spawn([tasks, 'agent-hook', provider], {
  cwd: projectRoot,
  env: { ...Bun.env, SCRUMLORD_HOOK_PROJECT_ROOT: projectRoot },
  stdin: 'pipe',
  stdout: debug || forwardStdout ? 'inherit' : 'pipe',
  stderr: debug ? 'inherit' : 'pipe',
});
subprocess.stdin.write(input);
subprocess.stdin.end();
await subprocess.exited;
process.exit(0);
`;

const ensureWrapper = async (projectRoot: string): Promise<{ path: string; changed: boolean }> => {
  const path = join(projectRoot, 'tmp', 'scrumlord-agent-hook.ts');
  const contents = wrapperScript(projectRoot);
  if (existsSync(path) && (await Bun.file(path).text()) === contents) {
    return { path, changed: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, contents);
  return { path, changed: true };
};

const commandFor = (wrapperPath: string, provider: string): string => {
  return `bun run ${JSON.stringify(wrapperPath)} ${provider}`;
};

const setupClaudeHooks = async (
  projectRoot: string,
  wrapperPath: string,
): Promise<SetupAgentHooksResult['claude']> => {
  const settingsPath = join(projectRoot, '.claude', 'settings.local.json');
  const configuration = await readJsonObject(settingsPath);
  const command = commandFor(wrapperPath, 'claude');
  const changed = [
    ensureHookEntry(configuration, 'SessionStart', 'startup|resume', command),
    ensureHookEntry(configuration, 'UserPromptSubmit', null, command),
    ensureHookEntry(configuration, 'PostToolUse', 'ExitPlanMode', command),
    ensureHookEntry(configuration, 'PostToolUse', 'Bash', command),
  ].some(Boolean);
  if (changed) await writeJsonObject(settingsPath, configuration);
  return { settingsPath, changed, skipped: false };
};

const ensureCodexHooksFeature = (configuration: string): string => {
  if (/^\s*codex_hooks\s*=\s*true\s*$/m.test(configuration)) return configuration;
  const replaced = configuration.replace(/^\s*codex_hooks\s*=\s*false\s*$/m, 'codex_hooks = true');
  if (replaced !== configuration) return replaced;
  if (/^\[features\]\s*$/m.test(configuration)) {
    return configuration.replace(/^\[features\]\s*$/m, '[features]\ncodex_hooks = true');
  }
  const separator = configuration.trim() ? '\n\n' : '';
  return `${configuration.replace(/\n*$/, '')}${separator}[features]\ncodex_hooks = true\n`;
};

const setupCodexHooks = async (
  projectRoot: string,
  wrapperPath: string,
): Promise<SetupAgentHooksResult['codex']> => {
  const configurationPath = join(projectRoot, '.codex', 'config.toml');
  const hooksPath = join(projectRoot, '.codex', 'hooks.json');
  mkdirSync(dirname(configurationPath), { recursive: true });

  const existingConfiguration = existsSync(configurationPath)
    ? await Bun.file(configurationPath).text()
    : '';
  const nextConfiguration = ensureCodexHooksFeature(existingConfiguration);
  const configurationChanged = nextConfiguration !== existingConfiguration;
  if (configurationChanged) await Bun.write(configurationPath, nextConfiguration);

  const hooks = await readJsonObject(hooksPath);
  const command = commandFor(wrapperPath, 'codex');
  const hooksChanged = [
    ensureHookEntry(hooks, 'SessionStart', 'startup|resume', command),
    ensureHookEntry(hooks, 'UserPromptSubmit', null, command),
    ensureHookEntry(hooks, 'PostToolUse', 'Bash', command),
    ensureHookEntry(hooks, 'Stop', null, command),
  ].some(Boolean);
  if (hooksChanged) await writeJsonObject(hooksPath, hooks);

  return {
    configurationPath,
    hooksPath,
    changed: configurationChanged || hooksChanged,
    skipped: false,
  };
};

/** Writes local Bun-based Claude and Codex hooks for Scrumlord task synchronization. */
export const setupAgentHooks = async (
  projectRoot: string,
  options: SetupAgentHooksOptions = {},
): Promise<SetupAgentHooksResult> => {
  const wrapper = await ensureWrapper(projectRoot);
  const providers = new Set(options.providers ?? ['claude', 'codex']);
  const claude = providers.has('claude')
    ? await setupClaudeHooks(projectRoot, wrapper.path)
    : {
        settingsPath: join(projectRoot, '.claude', 'settings.local.json'),
        changed: false,
        skipped: true,
      };
  const codex = providers.has('codex')
    ? await setupCodexHooks(projectRoot, wrapper.path)
    : {
        configurationPath: join(projectRoot, '.codex', 'config.toml'),
        hooksPath: join(projectRoot, '.codex', 'hooks.json'),
        changed: false,
        skipped: true,
      };

  return {
    wrapperPath: wrapper.path,
    claude: {
      ...claude,
      changed: providers.has('claude') && (claude.changed || wrapper.changed),
      skipped: !providers.has('claude'),
    },
    codex: {
      ...codex,
      changed: providers.has('codex') && (codex.changed || wrapper.changed),
      skipped: !providers.has('codex'),
    },
  };
};
