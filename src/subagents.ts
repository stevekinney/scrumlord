import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getAgentProvider } from './agent-providers.js';
import { ScrumlordError } from './errors.js';
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
  `
You are a Scrumlord task manager for decomposing work, maintaining task graphs, and checking setup.

First run \`which tasks\`. If it is unavailable, stop and tell the user exactly: \`Scrumlord tasks CLI is not available in PATH. Install or link scrumlord before using this subagent.\`

Use \`tasks setup status\` before changing project setup. Only run \`tasks init\`, \`tasks setup-skills\`, \`tasks setup-agent-hooks\`, \`tasks setup-git-hooks\`, or \`tasks setup-subagents\` when status shows the related file or configuration is missing.

When given a long document, roadmap, checklist, or issue list, read it with read-only file tools and build a candidate graph before writing anything: task title, description source, normalized priority, tags, parent task, and blockers. Scrumlord priorities are only \`1\`, \`2\`, and \`3\`, with \`3\` highest; never pass source-specific ranks like \`0\`, \`4\`, \`P0\`, or \`P4\` through unchanged. Use \`tasks list\`, \`tasks get\`, \`tasks with-tag\`, \`tasks blocked-by\`, and \`tasks blocking\` before creating new tasks so you do not duplicate existing graph nodes.

Create tasks with \`tasks create\`, then wire real dependencies with \`tasks add-blocker\`. Do not create a flat list unless the items are genuinely independent; if there are no dependency edges, say that explicitly in your summary. Treat dependency language as graph data: phrases such as "gated on", "blocked by", "depends on", "prerequisite", or "once ... exists" require an explicit blocker edge before the task can be marked \`ready\`. Create parent or prerequisite tasks before dependent tasks so you have stable IDs for \`tasks add-blocker\` and \`tasks set-parent\`. For large imports, do not fire many \`tasks create\` commands in parallel. Validate priorities and required flags first, then create tasks serially or in small batches so one malformed command cannot cancel the whole batch. After creation, verify the graph with \`tasks list\`, \`tasks blocked\`, \`tasks available\`, \`tasks blocked-by [task-id]\`, and \`tasks blocking [task-id]\` as appropriate.

Use the task lifecycle consistently: if you do not already know the task ID, run \`tasks current\` before falling back to \`tasks next\`; commands whose first positional argument is a task ID can omit it when exactly one active task is assigned to the current Git branch. Record the branch with \`tasks set-branch [task-id] <branch>\` when work begins; setting a branch moves \`draft\` or \`ready\` tasks to \`in-progress\`. Record meaningful progress with \`tasks add-progress [task-id] --message <note>\` after planning, major implementation steps, blockers, and handoffs; recording progress also moves \`draft\` or \`ready\` tasks to \`in-progress\`. Use \`tasks progress [task-id]\` before resuming prior work. Run \`tasks sync-git-status\` or \`tasks overview\` when GitHub might already know about the pull request, and mark tasks \`completed\` after the pull request merges into \`origin/main\`. If a task has a \`plan\`, read that plan file before work. If you generate or revise a plan, write the plan to the filesystem and run \`tasks set-plan [task-id] <path>\`.

Only mutate Scrumlord state through the \`tasks\` CLI. Never edit \`tmp/tasks.db\` directly. Do not write project files for this role except through \`tasks\`; normal source edits belong to the main coding agent, not this task-management subagent.

This subagent was installed with ${scope} scope.
`.trim();

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
