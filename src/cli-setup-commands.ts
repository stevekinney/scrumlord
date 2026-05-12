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
import { setupSubagents } from './subagents.js';
import type { ParsedArguments } from './cli-arguments.js';
import type { CliOptions, CliResult } from './cli-types.js';
import type { AgentProvider } from './types.js';
import { ScrumlordError } from './errors.js';
import { parseAgentProvider } from './validation.js';

type Which = (executable: string) => string | null;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const success = (value: unknown): CliResult => ({ exitCode: 0, stdout: json(value), stderr: '' });
const successWithStderr = (value: unknown, stderr: string): CliResult => ({
  exitCode: 0,
  stdout: json(value),
  stderr,
});

const normalizeSubagentTarget = (parsed: ParsedArguments): AgentProvider | '--all' | undefined => {
  const requestedTarget = parsed.flags.has('all') ? '--all' : parsed.positionals[0];
  if (requestedTarget === undefined) return undefined;
  if (requestedTarget === '-all' || requestedTarget === '--all') return '--all';
  return parseAgentProvider(requestedTarget);
};

const normalizeSetupScope = (parsed: ParsedArguments): 'local' | 'global' => {
  if (parsed.flags.has('local') && parsed.flags.has('global')) {
    throw new ScrumlordError('setup_scope_conflict', 'Use only one of --local or --global.');
  }
  return parsed.flags.has('global') ? 'global' : 'local';
};

export const runSetupSubagentsBoundaryCommand = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const root = await resolveProjectRoot(options.cwd);
  const target = normalizeSubagentTarget(parsed);
  return success(
    await (options.setupSubagents ?? setupSubagents)(root, {
      scope: normalizeSetupScope(parsed),
      ...(target === undefined ? {} : { target }),
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
      ...(options.which === undefined ? {} : { which: options.which }),
    }),
  );
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
  local: parsed.flags.has('local'),
  global: parsed.flags.has('global'),
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

export const runSetupBoundaryCommand = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const subcommand = parsed.positionals[0];
  if (subcommand === 'status') return await runSetupStatusBoundaryCommand(options);
  if (subcommand) {
    throw new ScrumlordError('unknown_command', `Unknown setup command: setup ${subcommand}.`);
  }
  const which = options.which ?? Bun.which;
  const selection = await setupSelectionFor(parsed, options, which);
  const project = await runSetupProjectFor(setupOptionsFor(selection, options, which), options);
  return await setupResultFor(selection, project, options);
};
