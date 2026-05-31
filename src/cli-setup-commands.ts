import {
  launchProviderInvocation,
  selectedInstalledProviders,
  setupProject,
  setupSelectionFromFlags,
  setupSelectionFromInput,
  setupStatus,
} from './setup.js';
import { setupAgentHooks } from './agent-hooks.js';
import { setupGitHooks } from './git-hooks.js';
import { resolveProjectRoot } from './root-resolution.js';
import { setupSkills, skillTargets, type SkillTarget } from './skills.js';
import { setupSubagents } from './subagents.js';
import { setupAgentPrompt } from './setup-prompt.js';
import { TASKS_START_SHELL_SNIPPET } from './cli-locate-command.js';
import type { ParsedArguments } from './cli-arguments.js';
import type { CliOptions, CliResult } from './cli-types.js';
import type { AgentProvider } from './types.js';
import { ScrumlordError } from './errors.js';

type Which = (executable: string) => string | null;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const success = (value: unknown): CliResult => ({ exitCode: 0, stdout: json(value), stderr: '' });
const rawString = (value: string): CliResult => ({
  exitCode: 0,
  stdout: value.endsWith('\n') ? value : `${value}\n`,
  stderr: '',
});
const successWithStderr = (value: unknown, stderr: string): CliResult => ({
  exitCode: 0,
  stdout: json(value),
  stderr,
});

const modeFlags = ['skills', 'subagents', 'git-hooks', 'agent-hooks', 'prompt', 'shell'] as const;
type ModeFlag = (typeof modeFlags)[number];

const selectedMode = (parsed: ParsedArguments): ModeFlag | undefined => {
  const selected = modeFlags.filter((flag) => parsed.flags.has(flag));
  if (selected.length === 0) return undefined;
  if (selected.length > 1) {
    throw new ScrumlordError(
      'setup_mode_conflict',
      `setup expects at most one mode flag; received: ${selected.map((flag) => `--${flag}`).join(', ')}.`,
    );
  }
  return selected[0];
};

type Scope = 'project' | 'user' | 'local';

const selectedScope = (parsed: ParsedArguments): Scope | undefined => {
  const scopes: Scope[] = ['project', 'user', 'local'];
  const selected = scopes.filter((scope) => parsed.flags.has(scope));
  if (selected.length === 0) return undefined;
  if (selected.length > 1) {
    throw new ScrumlordError(
      'setup_scope_conflict',
      `setup expects at most one of --project / --user / --local; received: ${selected.map((scope) => `--${scope}`).join(', ')}.`,
    );
  }
  return selected[0];
};

type AgentTarget = 'all' | 'claude' | 'codex';

const selectedAgent = (parsed: ParsedArguments): AgentTarget => {
  const values = parsed.flags.get('agent');
  if (!values || values.length === 0) return 'all';
  const value = values[values.length - 1];
  if (value === 'all' || value === 'claude' || value === 'codex') return value;
  throw new ScrumlordError(
    'invalid_agent',
    `--agent must be one of all, claude, codex (got ${value}).`,
  );
};

const skillTargetFor = (agent: AgentTarget): SkillTarget | '--all' => {
  if (agent === 'all') return '--all';
  if (skillTargets.includes(agent)) return agent;
  return '--all';
};

const runSkillsMode = async (parsed: ParsedArguments, options: CliOptions): Promise<CliResult> => {
  const scope = selectedScope(parsed) ?? 'project';
  if (scope === 'local') {
    throw new ScrumlordError(
      'setup_scope_not_applicable',
      '--skills does not support --local; use --project or --user.',
    );
  }
  if (scope === 'user') {
    throw new ScrumlordError(
      'setup_scope_not_applicable',
      '--skills --user is not yet implemented; use --project.',
    );
  }
  const root = await resolveProjectRoot(options.cwd);
  const target = skillTargetFor(selectedAgent(parsed));
  return success(await setupSkills(root, target));
};

const runSubagentsMode = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const scope = selectedScope(parsed) ?? 'project';
  if (scope === 'local') {
    throw new ScrumlordError(
      'setup_scope_not_applicable',
      '--subagents does not support --local; use --project or --user.',
    );
  }
  const subagentScope = scope === 'user' ? 'global' : 'local';
  const agent = selectedAgent(parsed);
  const target: AgentProvider | '--all' = agent === 'all' ? '--all' : agent;
  const root = await resolveProjectRoot(options.cwd);
  return success(
    await (options.setupSubagents ?? setupSubagents)(root, {
      scope: subagentScope,
      target,
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
      ...(options.which === undefined ? {} : { which: options.which }),
    }),
  );
};

const runGitHooksMode = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const scope = selectedScope(parsed) ?? 'project';
  if (scope !== 'project') {
    throw new ScrumlordError(
      'setup_scope_not_applicable',
      '--git-hooks only supports --project scope.',
    );
  }
  if (parsed.flags.get('agent')) {
    throw new ScrumlordError(
      'setup_agent_not_applicable',
      '--git-hooks does not accept --agent (git hooks are agent-neutral).',
    );
  }
  const root = await resolveProjectRoot(options.cwd);
  return success(await (options.setupGitHooks ?? setupGitHooks)(root));
};

const agentHookProvidersFor = (agent: AgentTarget): AgentProvider[] => {
  if (agent === 'all') return ['claude', 'codex'];
  return [agent];
};

const runAgentHooksMode = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const scope = selectedScope(parsed) ?? 'user';
  if (scope === 'project') {
    throw new ScrumlordError(
      'setup_scope_not_applicable',
      '--agent-hooks --project is not yet implemented; use --user.',
    );
  }
  if (scope === 'local') {
    throw new ScrumlordError(
      'setup_scope_not_applicable',
      '--agent-hooks --local is not yet implemented; use --user.',
    );
  }
  const agent = selectedAgent(parsed);
  const root = await resolveProjectRoot(options.cwd);
  const providers = agentHookProvidersFor(agent);
  return success(
    await (options.setupAgentHooks ?? setupAgentHooks)(root, {
      providers,
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    }),
  );
};

const runPromptMode = (parsed: ParsedArguments): CliResult => {
  if (selectedScope(parsed) !== undefined) {
    throw new ScrumlordError('setup_scope_not_applicable', '--prompt does not accept scope flags.');
  }
  if (parsed.flags.get('agent')) {
    throw new ScrumlordError('setup_agent_not_applicable', '--prompt does not accept --agent.');
  }
  return rawString(setupAgentPrompt);
};

const SHELL_UNEXPECTED_FLAGS = [
  'project',
  'user',
  'local',
  'claude',
  'codex',
  'yes',
  'all',
] as const;

const runShellSetup = (parsed: ParsedArguments): CliResult => {
  for (const flag of SHELL_UNEXPECTED_FLAGS) {
    if (parsed.flags.has(flag)) {
      throw new ScrumlordError('setup_shell_unexpected_flag', `--shell does not accept --${flag}.`);
    }
  }
  if (parsed.flags.has('agent')) {
    throw new ScrumlordError('setup_shell_unexpected_flag', '--shell does not accept --agent.');
  }
  return rawString(TASKS_START_SHELL_SNIPPET);
};

const runModeDispatch = async (
  mode: ModeFlag,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  if (mode === 'skills') return await runSkillsMode(parsed, options);
  if (mode === 'subagents') return await runSubagentsMode(parsed, options);
  if (mode === 'git-hooks') return await runGitHooksMode(parsed, options);
  if (mode === 'agent-hooks') return await runAgentHooksMode(parsed, options);
  if (mode === 'shell') return runShellSetup(parsed);
  return runPromptMode(parsed);
};

const runSetupStatusBoundaryCommand = async (options: CliOptions): Promise<CliResult> => {
  return success(
    await setupStatus({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
      ...(options.which === undefined ? {} : { which: options.which }),
    }),
  );
};

const runProviderInvocation = async (
  provider: AgentProvider,
  projectRoot: string,
  setup: unknown,
  options: CliOptions,
): Promise<number> => {
  const invocation = launchProviderInvocation(
    provider,
    projectRoot,
    options.which ?? Bun.which,
    setup,
  );
  if (options.runAgentInvocation) return await options.runAgentInvocation(invocation);
  const subprocess = Bun.spawn(invocation.command, {
    cwd: invocation.cwd,
    env: { ...Bun.env, ...options.environment, ...invocation.environment },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await subprocess.exited;
};

const setupFlagsFrom = (parsed: ParsedArguments) => ({
  claude: parsed.flags.has('claude'),
  codex: parsed.flags.has('codex'),
  local: parsed.flags.has('project'),
  global: parsed.flags.has('user'),
  yes: parsed.flags.has('yes'),
});

const setupSelectionFor = async (parsed: ParsedArguments, options: CliOptions, which: Which) => {
  const flags = setupFlagsFrom(parsed);
  if (flags.yes || flags.claude || flags.codex) {
    return { ...setupSelectionFromFlags(flags, which), prompt: '' };
  }
  return await setupSelectionFromInput({
    ...(options.colorMode === undefined ? {} : { colorMode: options.colorMode }),
    ...(options.readStdin === undefined ? {} : { readStdin: options.readStdin }),
    which,
  });
};

const setupOptionsFor = (
  selection: Awaited<ReturnType<typeof setupSelectionFor>>,
  options: CliOptions,
  which: Which,
) => ({
  ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  providers:
    selection.providers.length > 0 ? selection.providers : selectedInstalledProviders(which),
  scope: selection.scope,
  ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  which,
});

const runSetupProjectFor = async (
  setupOptions: ReturnType<typeof setupOptionsFor>,
  options: CliOptions,
) => {
  if (options.setupProject) return await options.setupProject(setupOptions);
  return await setupProject({
    ...setupOptions,
    setupSubagents,
    setupAgentHooks,
    setupGitHooks,
  });
};

const setupResultFor = async (
  selection: Awaited<ReturnType<typeof setupSelectionFor>>,
  project: Awaited<ReturnType<typeof runSetupProjectFor>>,
  options: CliOptions,
): Promise<CliResult> => {
  if (!selection.launchProvider) {
    return selection.prompt ? successWithStderr(project, selection.prompt) : success(project);
  }
  return {
    exitCode: await runProviderInvocation(
      selection.launchProvider,
      project.projectRoot,
      project,
      options,
    ),
    stdout: '',
    stderr: selection.prompt,
  };
};

const runInteractiveSetup = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const which = options.which ?? Bun.which;
  const selection = await setupSelectionFor(parsed, options, which);
  const project = await runSetupProjectFor(setupOptionsFor(selection, options, which), options);
  return await setupResultFor(selection, project, options);
};

export const runSetupBoundaryCommand = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const subcommand = parsed.positionals[0];
  if (subcommand === 'status') return await runSetupStatusBoundaryCommand(options);
  if (subcommand) {
    throw new ScrumlordError('unknown_command', `Unknown setup command: setup ${subcommand}.`);
  }
  const mode = selectedMode(parsed);
  if (mode) return await runModeDispatch(mode, parsed, options);
  return await runInteractiveSetup(parsed, options);
};
