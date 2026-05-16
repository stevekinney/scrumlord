import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getAgentProvider } from './agent-providers.js';
import { ScrumlordError } from './errors.js';
import subagentBody from './skills/scrumlord-task-manager.md';
import skillBody from './skills/tasks.md';
import type { AgentProvider } from './types.js';

export type SubagentScope = 'local' | 'global';

export type WhichExecutable = (executable: string) => string | null;

export type SetupSubagentsOptions = {
  target?: AgentProvider | '--all';
  scope?: SubagentScope;
  homeDirectory?: string;
  which?: WhichExecutable;
  writeSkills?: boolean;
};

export type WrittenSubagentSkill = {
  provider: AgentProvider;
  path: string;
  changed: boolean;
};

export type WrittenSubagent = {
  provider: AgentProvider;
  path: string;
  changed: boolean;
  settingsPath: string | null;
  settingsChanged: boolean;
};

export type SetupSubagentsResult = {
  projectRoot: string;
  scope: SubagentScope;
  providers: WrittenSubagent[];
  skills: WrittenSubagentSkill[];
  warnings: string[];
};

const subagentProviders: AgentProvider[] = ['codex', 'claude'];
const subagentName = 'scrumlord-task-manager';

const requiredClaudeAllowRules = ['Bash(tasks:*)', 'Bash(which tasks:*)'] as const;

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
      'subagent_configuration_invalid',
      `Could not parse subagent configuration ${path}: ${message}`,
    );
  }
  throw new ScrumlordError(
    'subagent_configuration_invalid',
    `Subagent configuration must be a JSON object: ${path}`,
  );
};

const ensureStringArray = (value: unknown): string[] => {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
};

const writeTextIfChanged = async (path: string, contents: string): Promise<boolean> => {
  if (existsSync(path) && (await Bun.file(path).text()) === contents) return false;
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, contents);
  return true;
};

const writeJsonObjectIfChanged = async (path: string, value: JsonObject): Promise<boolean> => {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  return await writeTextIfChanged(path, contents);
};

const executablePath = (provider: AgentProvider, which: WhichExecutable): string | null => {
  return which(getAgentProvider(provider).executable);
};

const installedProviders = (which: WhichExecutable): AgentProvider[] => {
  return subagentProviders.filter((provider) => executablePath(provider, which));
};

const selectedProviders = (
  target: AgentProvider | '--all' | undefined,
  which: WhichExecutable,
): { providers: AgentProvider[]; warnings: string[] } => {
  if (target === undefined) {
    const providers = installedProviders(which);
    return {
      providers,
      warnings: providers.length === 0 ? ['no_agent_provider_cli_found'] : [],
    };
  }

  const providers = target === '--all' ? subagentProviders : [target];
  const missingProviders = providers.filter((provider) => !executablePath(provider, which));
  if (missingProviders.length > 0) {
    throw new ScrumlordError(
      'provider_cli_not_found',
      `Could not find requested provider CLI in PATH: ${missingProviders.join(', ')}.`,
    );
  }
  return { providers, warnings: [] };
};

const providerSkillPath = (
  projectRoot: string,
  homeDirectory: string,
  provider: AgentProvider,
  scope: SubagentScope,
): string => {
  if (scope === 'global') return join(homeDirectory, `.${provider}`, 'skills', 'tasks', 'SKILL.md');
  return provider === 'codex'
    ? join(projectRoot, '.agents', 'skills', 'tasks', 'SKILL.md')
    : join(projectRoot, '.claude', 'skills', 'tasks', 'SKILL.md');
};

const subagentPath = (
  projectRoot: string,
  homeDirectory: string,
  provider: AgentProvider,
  scope: SubagentScope,
): string => {
  const root = scope === 'global' ? homeDirectory : projectRoot;
  return join(
    root,
    `.${provider}`,
    'agents',
    `${subagentName}.${provider === 'codex' ? 'toml' : 'md'}`,
  );
};

const claudeSettingsPath = (
  projectRoot: string,
  homeDirectory: string,
  scope: SubagentScope,
): string => {
  return scope === 'global'
    ? join(homeDirectory, '.claude', 'settings.json')
    : join(projectRoot, '.claude', 'settings.local.json');
};

const sharedInstructions = (scope: SubagentScope): string =>
  `${subagentBody}\n\nThis subagent was installed with ${scope} scope.`;

const codexSubagentContents = (
  projectRoot: string,
  homeDirectory: string,
  scope: SubagentScope,
): string => {
  const skillPath = providerSkillPath(projectRoot, homeDirectory, 'codex', scope);
  return [
    `name = ${JSON.stringify(subagentName)}`,
    'description = "Breaks long documents and task lists into Scrumlord tasks, sets dependencies, and checks Scrumlord setup."',
    'sandbox_mode = "workspace-write"',
    `developer_instructions = ${JSON.stringify(sharedInstructions(scope))}`,
    '',
    '[[skills.config]]',
    `path = ${JSON.stringify(skillPath)}`,
    'enabled = true',
    '',
  ].join('\n');
};

const claudeSubagentContents = (scope: SubagentScope): string => {
  return [
    '---',
    `name: ${subagentName}`,
    'description: Break long documents and task lists into Scrumlord tasks, set dependencies, and check Scrumlord setup.',
    'tools: Read, Grep, Glob, Bash',
    'permissionMode: default',
    'skills:',
    '  - tasks',
    'color: orange',
    '---',
    '',
    sharedInstructions(scope),
    '',
  ].join('\n');
};

const mergeClaudeAllowRules = async (path: string): Promise<boolean> => {
  const settings = await readJsonObject(path);
  const permissions = isRecord(settings['permissions']) ? settings['permissions'] : {};
  settings['permissions'] = permissions;
  const allow = ensureStringArray(permissions['allow']);
  const before = allow.length;
  for (const rule of requiredClaudeAllowRules) {
    if (!allow.includes(rule)) allow.push(rule);
  }
  permissions['allow'] = allow;
  if (allow.length === before && existsSync(path)) return false;
  return await writeJsonObjectIfChanged(path, settings);
};

const writeProviderSkill = async (
  projectRoot: string,
  homeDirectory: string,
  provider: AgentProvider,
  scope: SubagentScope,
): Promise<WrittenSubagentSkill> => {
  const path = providerSkillPath(projectRoot, homeDirectory, provider, scope);
  return {
    provider,
    path,
    changed: await writeTextIfChanged(path, skillBody),
  };
};

const writeProviderSubagent = async (
  projectRoot: string,
  homeDirectory: string,
  provider: AgentProvider,
  scope: SubagentScope,
): Promise<WrittenSubagent> => {
  const path = subagentPath(projectRoot, homeDirectory, provider, scope);
  const contents =
    provider === 'codex'
      ? codexSubagentContents(projectRoot, homeDirectory, scope)
      : claudeSubagentContents(scope);
  const changed = await writeTextIfChanged(path, contents);
  if (provider === 'codex')
    return { provider, path, changed, settingsPath: null, settingsChanged: false };

  const settingsPath = claudeSettingsPath(projectRoot, homeDirectory, scope);
  return {
    provider,
    path,
    changed,
    settingsPath,
    settingsChanged: await mergeClaudeAllowRules(settingsPath),
  };
};

/** Writes Scrumlord task-manager subagents for installed or requested agent CLIs. */
export const setupSubagents = async (
  projectRoot: string,
  options: SetupSubagentsOptions = {},
): Promise<SetupSubagentsResult> => {
  const scope = options.scope ?? 'local';
  const homeDirectory = options.homeDirectory ?? homedir();
  const which = options.which ?? Bun.which;
  const selection = selectedProviders(options.target, which);
  const writeSkills = options.writeSkills ?? true;
  const skills: WrittenSubagentSkill[] = [];
  const providers: WrittenSubagent[] = [];

  for (const provider of selection.providers) {
    if (writeSkills)
      skills.push(await writeProviderSkill(projectRoot, homeDirectory, provider, scope));
    providers.push(await writeProviderSubagent(projectRoot, homeDirectory, provider, scope));
  }

  return {
    projectRoot,
    scope,
    providers,
    skills,
    warnings: selection.warnings,
  };
};

export const subagentPaths = {
  providerSkillPath,
  subagentPath,
  claudeSettingsPath,
} as const;
