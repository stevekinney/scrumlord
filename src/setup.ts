import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createTheme, type ColorMode } from './color.js';
import { createTaskStore } from './database-open.js';
import { ScrumlordError } from './errors.js';
import { agentHookPaths, setupAgentHooks, type SetupAgentHooksResult } from './agent-hooks.js';
import { buildSetupInvocation, getAgentProvider, type AgentInvocation } from './agent-providers.js';
import { setupGitHooks, type SetupGitHooksResult } from './git-hooks.js';
import { resolveProjectRoot } from './root-resolution.js';
import { setupSkills, type WrittenSkill } from './skills.js';
import {
  setupSubagents,
  subagentPaths,
  type SetupSubagentsResult,
  type SubagentScope,
  type WhichExecutable,
} from './subagents.js';
import type { AgentProvider } from './types.js';

export type SetupStatusProvider = {
  executable: string | null;
  localSubagentPath: string | null;
  localSubagentExists: boolean;
  globalSubagentPath: string;
  globalSubagentExists: boolean;
};

export type SetupStatusSkill = {
  localPath: string | null;
  localExists: boolean;
  globalPath: string;
  globalExists: boolean;
};

export type SetupStatus = {
  tasksExecutable: string | null;
  projectRoot: string | null;
  databaseExists: boolean;
  providers: Record<AgentProvider, SetupStatusProvider>;
  skillPaths: Record<'codex' | 'claude' | 'cursor', SetupStatusSkill>;
  hooks: {
    lefthookConfigurationExists: boolean;
    agentHookWrapperExists: boolean;
    claudeSettingsExists: boolean;
    codexConfigurationExists: boolean;
    codexHooksExists: boolean;
  };
  warnings: string[];
};

export type SetupProjectOptions = {
  cwd?: string;
  providers?: readonly AgentProvider[];
  scope?: SubagentScope;
  homeDirectory?: string;
  which?: WhichExecutable;
  setupSubagents?: typeof setupSubagents;
  setupAgentHooks?: typeof setupAgentHooks;
  setupGitHooks?: typeof setupGitHooks;
};

export type SetupProjectResult = {
  projectRoot: string;
  databasePath: string;
  skills: WrittenSkill[];
  subagents: SetupSubagentsResult | null;
  agentHooks: SetupAgentHooksResult | null;
  gitHooks: SetupGitHooksResult;
  warnings: string[];
};

export type SetupSelection = {
  providers: AgentProvider[];
  scope: SubagentScope;
  launchProvider: AgentProvider | null;
  prompt: string;
};

type SetupStatusOptions = {
  cwd?: string;
  homeDirectory?: string;
  which?: WhichExecutable;
};

const providerNames: AgentProvider[] = ['codex', 'claude'];
const providerAnswerMap = new Map<string, readonly AgentProvider[] | 'installed'>([
  ['', 'installed'],
  ['1', 'installed'],
  ['installed', 'installed'],
  ['2', ['codex']],
  ['codex', ['codex']],
  ['3', ['claude']],
  ['claude', ['claude']],
  ['4', providerNames],
  ['all', providerNames],
  ['both', providerNames],
]);

const providerExecutable = (provider: AgentProvider, which: WhichExecutable): string | null => {
  return which(getAgentProvider(provider).executable);
};

const installedProviders = (which: WhichExecutable): AgentProvider[] => {
  return providerNames.filter((provider) => providerExecutable(provider, which));
};

export const selectedInstalledProviders = (which: WhichExecutable = Bun.which): AgentProvider[] => {
  return installedProviders(which);
};

const requireProviderExecutable = (provider: AgentProvider, which: WhichExecutable): void => {
  if (!providerExecutable(provider, which)) {
    throw new ScrumlordError(
      'provider_cli_not_found',
      `Could not find ${getAgentProvider(provider).executable} in PATH.`,
    );
  }
};

const localSkillPath = (projectRoot: string | null, target: 'codex' | 'claude' | 'cursor') => {
  if (!projectRoot) return null;
  if (target === 'codex') return join(projectRoot, '.agents', 'skills', 'tasks', 'SKILL.md');
  if (target === 'claude') return join(projectRoot, '.claude', 'skills', 'tasks', 'SKILL.md');
  return join(projectRoot, '.cursor', 'rules', 'tasks.md');
};

const globalSkillPath = (homeDirectory: string, target: 'codex' | 'claude' | 'cursor') => {
  return join(homeDirectory, `.${target}`, 'skills', 'tasks', 'SKILL.md');
};

const statusSkill = (
  projectRoot: string | null,
  homeDirectory: string,
  target: 'codex' | 'claude' | 'cursor',
): SetupStatusSkill => {
  const localPath = localSkillPath(projectRoot, target);
  const globalPath = globalSkillPath(homeDirectory, target);
  return {
    localPath,
    localExists: localPath ? existsSync(localPath) : false,
    globalPath,
    globalExists: existsSync(globalPath),
  };
};

const statusProvider = (
  projectRoot: string | null,
  homeDirectory: string,
  provider: AgentProvider,
  which: WhichExecutable,
): SetupStatusProvider => {
  const localSubagentPath = projectRoot
    ? subagentPaths.subagentPath(projectRoot, homeDirectory, provider, 'local')
    : null;
  const globalSubagentPath = subagentPaths.subagentPath(
    projectRoot ?? process.cwd(),
    homeDirectory,
    provider,
    'global',
  );
  return {
    executable: providerExecutable(provider, which),
    localSubagentPath,
    localSubagentExists: localSubagentPath ? existsSync(localSubagentPath) : false,
    globalSubagentPath,
    globalSubagentExists: existsSync(globalSubagentPath),
  };
};

const resolveProjectRootForStatus = async (
  cwd: string | undefined,
  warnings: string[],
): Promise<string | null> => {
  try {
    return await resolveProjectRoot(cwd);
  } catch {
    warnings.push('project_root_not_found');
    return null;
  }
};

const rootFileExists = (projectRoot: string | null, ...segments: string[]): boolean => {
  return projectRoot ? existsSync(join(projectRoot, ...segments)) : false;
};

const setupStatusHooks = (
  projectRoot: string | null,
  homeDirectory: string,
): SetupStatus['hooks'] => ({
  lefthookConfigurationExists:
    rootFileExists(projectRoot, 'lefthook.yml') || rootFileExists(projectRoot, 'lefthook.yaml'),
  agentHookWrapperExists: existsSync(agentHookPaths.legacyWrapperPath(homeDirectory)),
  claudeSettingsExists: existsSync(agentHookPaths.claudeSettingsPath(homeDirectory)),
  codexConfigurationExists: existsSync(agentHookPaths.codexConfigurationPath(homeDirectory)),
  codexHooksExists: existsSync(agentHookPaths.codexHooksPath(homeDirectory)),
});

const setupStatusProviders = (
  projectRoot: string | null,
  homeDirectory: string,
  which: WhichExecutable,
): Record<AgentProvider, SetupStatusProvider> => ({
  codex: statusProvider(projectRoot, homeDirectory, 'codex', which),
  claude: statusProvider(projectRoot, homeDirectory, 'claude', which),
});

const setupStatusSkills = (
  projectRoot: string | null,
  homeDirectory: string,
): SetupStatus['skillPaths'] => ({
  codex: statusSkill(projectRoot, homeDirectory, 'codex'),
  claude: statusSkill(projectRoot, homeDirectory, 'claude'),
  cursor: statusSkill(projectRoot, homeDirectory, 'cursor'),
});

/** Reads setup state without creating the Scrumlord database or writing files. */
export const setupStatus = async (options: SetupStatusOptions = {}): Promise<SetupStatus> => {
  const homeDirectory = options.homeDirectory ?? homedir();
  const which = options.which ?? Bun.which;
  const warnings: string[] = [];
  const projectRoot = await resolveProjectRootForStatus(options.cwd, warnings);
  const tasksExecutable = which('tasks');
  if (!tasksExecutable) warnings.push('tasks_executable_not_found');

  return {
    tasksExecutable,
    projectRoot,
    databaseExists: rootFileExists(projectRoot, 'tmp', 'tasks.db'),
    providers: setupStatusProviders(projectRoot, homeDirectory, which),
    skillPaths: setupStatusSkills(projectRoot, homeDirectory),
    hooks: setupStatusHooks(projectRoot, homeDirectory),
    warnings,
  };
};

const writeSelectedSkills = async (
  projectRoot: string,
  providers: readonly AgentProvider[],
): Promise<WrittenSkill[]> => {
  const skills: WrittenSkill[] = [];
  for (const provider of providers) skills.push(...(await setupSkills(projectRoot, provider)));
  return skills;
};

const setupProviders = (options: SetupProjectOptions): AgentProvider[] => {
  return [...(options.providers ?? selectedInstalledProviders(options.which ?? Bun.which))];
};

const subagentTargetFor = (providers: readonly AgentProvider[]): AgentProvider | '--all' => {
  const [firstProvider] = providers;
  return providers.length === providerNames.length ? '--all' : firstProvider!;
};

const setupSubagentsForProviders = async (
  projectRoot: string,
  providers: readonly AgentProvider[],
  scope: SubagentScope,
  options: SetupProjectOptions,
): Promise<SetupSubagentsResult | null> => {
  if (providers.length === 0) return null;
  const subagentOptions = {
    target: subagentTargetFor(providers),
    scope,
    writeSkills: false,
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    ...(options.which === undefined ? {} : { which: options.which }),
  };
  return await (options.setupSubagents ?? setupSubagents)(projectRoot, subagentOptions);
};

const setupAgentHooksForProviders = async (
  projectRoot: string,
  providers: readonly AgentProvider[],
  options: SetupProjectOptions,
): Promise<SetupAgentHooksResult | null> => {
  if (providers.length === 0) return null;
  return await (options.setupAgentHooks ?? setupAgentHooks)(projectRoot, {
    providers,
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  });
};

/** Initializes Scrumlord setup surfaces for the selected providers. */
export const setupProject = async (
  options: SetupProjectOptions = {},
): Promise<SetupProjectResult> => {
  const scope = options.scope ?? 'local';
  const providers = setupProviders(options);
  const warnings = providers.length === 0 ? ['no_agent_provider_cli_found'] : [];
  const store = await createTaskStore(options.cwd === undefined ? {} : { cwd: options.cwd });

  try {
    const skills = await writeSelectedSkills(store.projectRoot, providers);
    const subagents = await setupSubagentsForProviders(
      store.projectRoot,
      providers,
      scope,
      options,
    );
    const agentHooks = await setupAgentHooksForProviders(store.projectRoot, providers, options);
    const gitHooks = await (options.setupGitHooks ?? setupGitHooks)(store.projectRoot);

    return {
      projectRoot: store.projectRoot,
      databasePath: store.databasePath,
      skills,
      subagents,
      agentHooks,
      gitHooks,
      warnings,
    };
  } finally {
    store.close();
  }
};

const normalizeProviderAnswer = (answer: string, which: WhichExecutable): AgentProvider[] => {
  const normalized = answer.trim().toLowerCase();
  const providers = providerAnswerMap.get(normalized);
  if (providers === 'installed') return selectedInstalledProviders(which);
  if (providers) return [...providers];
  throw new ScrumlordError(
    'invalid_setup_provider',
    'Setup provider must be 1, 2, 3, 4, installed, codex, claude, all, or both.',
  );
};

const normalizeScopeAnswer = (answer: string): SubagentScope => {
  const normalized = answer.trim().toLowerCase();
  if (!normalized || normalized === '1' || normalized === 'local') return 'local';
  if (normalized === '2' || normalized === 'global') return 'global';
  throw new ScrumlordError('invalid_setup_scope', 'Setup scope must be 1, 2, local, or global.');
};

const normalizeLaunchAnswer = (answer: string): AgentProvider | null => {
  const normalized = answer.trim().toLowerCase();
  if (!normalized || normalized === '1' || normalized === 'none' || normalized === 'no') {
    return null;
  }
  if (normalized === '2' || normalized === 'codex') return 'codex';
  if (normalized === '3' || normalized === 'claude') return 'claude';
  throw new ScrumlordError(
    'invalid_setup_launch_provider',
    'Launch provider must be 1, 2, 3, none, codex, or claude.',
  );
};

const setupPrompt = (colorMode: ColorMode): string => {
  const theme = createTheme(colorMode);
  return [
    theme.title('Scrumlord Setup'),
    theme.heading('Which agents should Scrumlord configure?'),
    theme.muted('1. Installed CLIs (recommended)'),
    theme.muted('2. Codex only'),
    theme.muted('3. Claude only'),
    theme.muted('4. Codex and Claude'),
    theme.heading('Where should the subagents be installed?'),
    theme.muted('1. Project-local (recommended)'),
    theme.muted('2. User-global'),
    theme.heading('Launch an agent after setup?'),
    theme.muted('1. No'),
    theme.muted('2. Codex'),
    theme.muted('3. Claude'),
    '',
  ].join('\n');
};

export const readTerminalSetupInput = async (
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> => {
  const interface_ = createInterface({ input, output });
  try {
    const lines = interface_[Symbol.asyncIterator]();
    const providers = await readSetupLine(lines, output, [
      'Which agents should Scrumlord configure?',
      '  1. Installed CLIs (recommended)',
      '  2. Codex only',
      '  3. Claude only',
      '  4. Codex and Claude',
      'Choose 1-4 [1]: ',
    ]);
    const scope = await readSetupLine(lines, output, [
      'Where should the subagents be installed?',
      '  1. Project-local (recommended)',
      '  2. User-global',
      'Choose 1-2 [1]: ',
    ]);
    const launch = await readSetupLine(lines, output, [
      'Launch an agent after setup?',
      '  1. No',
      '  2. Codex',
      '  3. Claude',
      'Choose 1-3 [1]: ',
    ]);
    return [providers, scope, launch].join('\n');
  } finally {
    interface_.close();
  }
};

const readSetupLine = async (
  lines: AsyncIterator<string>,
  output: NodeJS.WritableStream,
  promptLines: string[],
): Promise<string> => {
  output.write(promptLines.join('\n'));
  const next = await lines.next();
  output.write('\n');
  return next.done ? '' : next.value;
};

const readInteractiveInput = async (options: {
  isTTY?: boolean;
  readStdin?: () => Promise<string>;
  terminalInput?: NodeJS.ReadableStream;
  terminalOutput?: NodeJS.WritableStream;
}): Promise<string> => {
  if (options.readStdin) return await options.readStdin();
  const isTTY = options.isTTY ?? process.stdin.isTTY;
  if (!isTTY) {
    throw new ScrumlordError(
      'setup_input_required',
      'Interactive setup requires a TTY. Use --yes, --codex, or --claude in non-interactive environments.',
    );
  }
  return await readTerminalSetupInput(
    options.terminalInput ?? process.stdin,
    options.terminalOutput ?? process.stderr,
  );
};

const requireProvidersAvailable = (
  providers: readonly AgentProvider[],
  which: WhichExecutable,
): void => {
  for (const provider of providers) requireProviderExecutable(provider, which);
};

const pushLaunchProvider = (
  providers: AgentProvider[],
  launchProvider: AgentProvider | null,
): void => {
  if (launchProvider && !providers.includes(launchProvider)) providers.push(launchProvider);
};

export const setupSelectionFromInput = async (
  options: {
    colorMode?: ColorMode;
    isTTY?: boolean;
    readStdin?: () => Promise<string>;
    terminalInput?: NodeJS.ReadableStream;
    terminalOutput?: NodeJS.WritableStream;
    which?: WhichExecutable;
  } = {},
): Promise<SetupSelection> => {
  const which = options.which ?? Bun.which;
  const prompt = options.readStdin ? setupPrompt(options.colorMode ?? 'auto') : '';
  const input = await readInteractiveInput(options);
  const [providerAnswer = '', scopeAnswer = '', launchAnswer = ''] = input.split(/\r?\n/);
  const providers = normalizeProviderAnswer(providerAnswer, which);
  const scope = normalizeScopeAnswer(scopeAnswer);
  const launchProvider = normalizeLaunchAnswer(launchAnswer);
  pushLaunchProvider(providers, launchProvider);
  requireProvidersAvailable(providers, which);
  return { providers, scope, launchProvider, prompt };
};

const assertSetupFlagCompatibility = (flags: {
  codex?: boolean;
  claude?: boolean;
  local?: boolean;
  global?: boolean;
}): void => {
  if (flags.codex && flags.claude) {
    throw new ScrumlordError('setup_provider_conflict', 'Use only one of --codex or --claude.');
  }
  if (flags.local && flags.global) {
    throw new ScrumlordError('setup_scope_conflict', 'Use only one of --local or --global.');
  }
};

const launchProviderFromFlags = (flags: {
  codex?: boolean;
  claude?: boolean;
}): AgentProvider | null => {
  if (flags.codex) return 'codex';
  if (flags.claude) return 'claude';
  return null;
};

const providersFromFlags = (
  flags: { yes?: boolean },
  launchProvider: AgentProvider | null,
  which: WhichExecutable,
): AgentProvider[] => {
  if (launchProvider) return [launchProvider];
  return flags.yes ? selectedInstalledProviders(which) : [];
};

export const setupSelectionFromFlags = (
  flags: { codex?: boolean; claude?: boolean; yes?: boolean; local?: boolean; global?: boolean },
  which: WhichExecutable = Bun.which,
): Omit<SetupSelection, 'prompt'> => {
  assertSetupFlagCompatibility(flags);
  const scope: SubagentScope = flags.global ? 'global' : 'local';
  const launchProvider = launchProviderFromFlags(flags);
  const providers = providersFromFlags(flags, launchProvider, which);
  requireProvidersAvailable(providers, which);
  return { providers, scope, launchProvider };
};

export const launchProviderInvocation = (
  provider: AgentProvider,
  projectRoot: string,
  which: WhichExecutable = Bun.which,
  setup: unknown = { projectRoot },
): AgentInvocation => {
  requireProviderExecutable(provider, which);
  const invocation = buildSetupInvocation(provider, { projectRoot, setup });
  const executable = which(getAgentProvider(provider).executable)!;
  return {
    ...invocation,
    command: [executable, ...invocation.command.slice(1)],
  };
};
