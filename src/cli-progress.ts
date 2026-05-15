import { flag } from './cli-arguments.js';
import { ScrumlordError } from './errors.js';
import type { AddTaskProgressInput } from './types.js';
import { parseAgentProvider, parseProgressEvent } from './validation.js';

export type ProgressFromFlagsOptions = {
  environment?: Record<string, string | undefined> | undefined;
};

type Environment = Record<string, string | undefined>;

const envProvider = (env: Environment): AddTaskProgressInput['provider'] => {
  if (env['CODEX_SESSION_ID']) return 'codex';
  if (env['CLAUDECODE'] === '1') return 'claude';
  return undefined;
};

const resolveProvider = (
  flags: Map<string, string[]>,
  env: Environment,
): Pick<AddTaskProgressInput, 'provider'> => {
  const provider = flag(flags, 'provider');
  if (provider !== undefined)
    return { provider: provider.trim() ? parseAgentProvider(provider) : null };
  const derived = envProvider(env);
  return derived !== undefined ? { provider: derived } : {};
};

const resolveSession = (
  flags: Map<string, string[]>,
  env: Environment,
): Pick<AddTaskProgressInput, 'session'> => {
  const session = flag(flags, 'session');
  if (session !== undefined) return { session: session || null };
  const codexSession = env['CODEX_SESSION_ID'];
  return codexSession ? { session: codexSession } : {};
};

const resolveMetadata = (
  flags: Map<string, string[]>,
  env: Environment,
): Pick<AddTaskProgressInput, 'event' | 'tool' | 'cwd'> => {
  const result: Pick<AddTaskProgressInput, 'event' | 'tool' | 'cwd'> = {};
  const event = flag(flags, 'event');
  if (event !== undefined && event.trim()) result.event = parseProgressEvent(event.trim());
  const tool = flag(flags, 'tool');
  if (tool !== undefined && tool.trim()) result.tool = tool.trim();
  const cwd = flag(flags, 'cwd');
  result.cwd = cwd !== undefined ? cwd || null : (env['CLAUDE_PROJECT_DIR'] ?? process.cwd());
  return result;
};

export const progressInputFromFlags = (
  flags: Map<string, string[]>,
  options: ProgressFromFlagsOptions = {},
): AddTaskProgressInput => {
  const message = flag(flags, 'message');
  if (!message) throw new ScrumlordError('missing_progress_message', '--message is required.');

  const env = options.environment ?? Bun.env;
  return {
    message,
    ...resolveProvider(flags, env),
    ...resolveSession(flags, env),
    ...resolveMetadata(flags, env),
  };
};
