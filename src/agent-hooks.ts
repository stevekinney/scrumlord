import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ScrumlordError } from './errors.js';
import type { AgentProvider } from './types.js';

export type SetupAgentHooksResult = {
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
  homeDirectory?: string;
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

const commandFor = (provider: AgentProvider): string => {
  // Guard with `command -v` so the hook silently no-ops when the tasks CLI is
  // not installed; the trailing `|| true` keeps the hook from failing the
  // host harness when tasks is missing. Both Claude Code and Codex invoke
  // hook commands through a shell, so this expression is portable.
  return `command -v tasks >/dev/null 2>&1 && tasks agent-hook ${provider} || true`;
};

const isLegacyWrapperCommand = (command: unknown, provider: AgentProvider): boolean => {
  if (typeof command !== 'string') return false;
  // Legacy wrapper: `bun run "<path>/scrumlord-agent-hook.ts" <provider>`
  const legacyPattern = new RegExp(
    `bun\\s+run\\s+(?:"[^"]*"|'[^']*'|\\S+)scrumlord-agent-hook\\.ts(?:"|')?\\s+${provider}\\b`,
  );
  return legacyPattern.test(command);
};

const entryMatchesCommand = (entry: unknown, matcher: string | null, command: string): boolean => {
  if (!isRecord(entry) || !Array.isArray(entry['hooks'])) return false;
  const entryMatcher = typeof entry['matcher'] === 'string' ? entry['matcher'] : null;
  if (entryMatcher !== matcher) return false;
  return entry['hooks'].some((hook) => isRecord(hook) && hook['command'] === command);
};

const migrateEntryCommands = (
  entry: unknown,
  provider: AgentProvider,
  command: string,
): boolean => {
  if (!isRecord(entry) || !Array.isArray(entry['hooks'])) return false;
  let migrated = false;
  for (const hook of entry['hooks']) {
    if (!isRecord(hook)) continue;
    if (isLegacyWrapperCommand(hook['command'], provider) && hook['command'] !== command) {
      hook['command'] = command;
      migrated = true;
    }
  }
  return migrated;
};

const ensureHookEntry = (
  configuration: JsonObject,
  event: string,
  matcher: string | null,
  provider: AgentProvider,
): boolean => {
  const hooks = isRecord(configuration['hooks']) ? configuration['hooks'] : {};
  configuration['hooks'] = hooks;
  const entries = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
  const command = commandFor(provider);

  let changed = false;

  // Step 1: migrate any legacy wrapper-based entries with a matching matcher.
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const entryMatcher = typeof entry['matcher'] === 'string' ? entry['matcher'] : null;
    if (entryMatcher !== matcher) continue;
    if (migrateEntryCommands(entry, provider, command)) changed = true;
  }

  // Step 2: ensure the canonical entry is present.
  const alreadyRegistered = entries.some((entry) => entryMatchesCommand(entry, matcher, command));
  if (!alreadyRegistered) {
    const entry: JsonObject = {
      hooks: [{ type: 'command', command, timeout: 10 }],
    };
    if (matcher) entry['matcher'] = matcher;
    entries.push(entry);
    changed = true;
  }

  hooks[event] = entries;
  return changed;
};

const claudeSettingsPath = (homeDirectory: string): string => {
  return join(homeDirectory, '.claude', 'settings.json');
};

const codexConfigurationPath = (homeDirectory: string): string => {
  return join(homeDirectory, '.codex', 'config.toml');
};

const codexHooksPath = (homeDirectory: string): string => {
  return join(homeDirectory, '.codex', 'hooks.json');
};

// Path of the obsolete wrapper script. Retained so callers can detect a
// stale wrapper and prompt the user to delete it.
const legacyWrapperPath = (homeDirectory: string): string => {
  return join(homeDirectory, '.scrumlord', 'hooks', 'scrumlord-agent-hook.ts');
};

export const agentHookPaths = {
  legacyWrapperPath,
  claudeSettingsPath,
  codexConfigurationPath,
  codexHooksPath,
} as const;

const setupClaudeHooks = async (
  homeDirectory: string,
): Promise<SetupAgentHooksResult['claude']> => {
  const settingsPath = claudeSettingsPath(homeDirectory);
  const configuration = await readJsonObject(settingsPath);
  const changed = [
    ensureHookEntry(configuration, 'SessionStart', 'startup|resume', 'claude'),
    ensureHookEntry(configuration, 'UserPromptSubmit', null, 'claude'),
    ensureHookEntry(configuration, 'PostToolUse', 'ExitPlanMode', 'claude'),
    ensureHookEntry(configuration, 'PostToolUse', 'Bash', 'claude'),
    ensureHookEntry(configuration, 'Stop', null, 'claude'),
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

const setupCodexHooks = async (homeDirectory: string): Promise<SetupAgentHooksResult['codex']> => {
  const configurationPath = codexConfigurationPath(homeDirectory);
  const hooksPath = codexHooksPath(homeDirectory);
  mkdirSync(dirname(configurationPath), { recursive: true });

  const existingConfiguration = existsSync(configurationPath)
    ? await Bun.file(configurationPath).text()
    : '';
  const nextConfiguration = ensureCodexHooksFeature(existingConfiguration);
  const configurationChanged = nextConfiguration !== existingConfiguration;
  if (configurationChanged) await Bun.write(configurationPath, nextConfiguration);

  const hooks = await readJsonObject(hooksPath);
  const hooksChanged = [
    ensureHookEntry(hooks, 'SessionStart', 'startup|resume', 'codex'),
    ensureHookEntry(hooks, 'UserPromptSubmit', null, 'codex'),
    ensureHookEntry(hooks, 'PostToolUse', 'Bash', 'codex'),
    ensureHookEntry(hooks, 'Stop', null, 'codex'),
  ].some(Boolean);
  if (hooksChanged) await writeJsonObject(hooksPath, hooks);

  return {
    configurationPath,
    hooksPath,
    changed: configurationChanged || hooksChanged,
    skipped: false,
  };
};

/** Writes global Claude and Codex hook configuration that calls `tasks agent-hook` directly. */
export const setupAgentHooks = async (
  _projectRoot: string,
  options: SetupAgentHooksOptions = {},
): Promise<SetupAgentHooksResult> => {
  const homeDirectory = options.homeDirectory ?? homedir();
  const providers = new Set(options.providers ?? ['claude', 'codex']);
  const claude = providers.has('claude')
    ? await setupClaudeHooks(homeDirectory)
    : {
        settingsPath: claudeSettingsPath(homeDirectory),
        changed: false,
        skipped: true,
      };
  const codex = providers.has('codex')
    ? await setupCodexHooks(homeDirectory)
    : {
        configurationPath: codexConfigurationPath(homeDirectory),
        hooksPath: codexHooksPath(homeDirectory),
        changed: false,
        skipped: true,
      };

  return {
    claude: {
      ...claude,
      skipped: !providers.has('claude'),
    },
    codex: {
      ...codex,
      skipped: !providers.has('codex'),
    },
  };
};
