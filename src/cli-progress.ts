import { flag } from './cli-arguments.js';
import { ScrumlordError } from './errors.js';
import type { AddTaskProgressInput, Task } from './types.js';
import { parseAgentProvider, parseProgressEvent } from './validation.js';

type Environment = Record<string, string | undefined>;

export type ProgressFromContextOptions = {
  flags: Map<string, string[]>;
  environment?: Environment | undefined;
  task?: Task | null | undefined;
};

const inferProvider = (
  env: Environment,
  task: Task | null | undefined,
): AddTaskProgressInput['provider'] => {
  const scrumlordCli = env['SCRUMLORD_CLI'];
  if (scrumlordCli) {
    try {
      return parseAgentProvider(scrumlordCli);
    } catch {
      // not a valid provider — fall through
    }
  }
  if (env['CLAUDECODE'] === '1') return 'claude';
  if (env['CODEX_SESSION_ID']) return 'codex';
  if (env['CLAUDE_SESSION_ID']) return 'claude';
  return task?.provider ?? undefined;
};

const sessionFromEnvForProvider = (
  provider: 'claude' | 'codex',
  env: Environment,
  task: Task | null | undefined,
): string | undefined => {
  const envKey = provider === 'claude' ? 'CLAUDE_SESSION_ID' : 'CODEX_SESSION_ID';
  const envSession = env[envKey];
  if (envSession) return envSession;
  if (task?.provider === provider && task.session) return task.session;
  return undefined;
};

const inferSession = (
  provider: AddTaskProgressInput['provider'],
  env: Environment,
  task: Task | null | undefined,
): AddTaskProgressInput['session'] => {
  if (provider !== 'claude' && provider !== 'codex') return undefined;
  return sessionFromEnvForProvider(provider, env, task);
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

const resolveProviderForOrphanSession = (
  env: Environment,
  task: Task | null | undefined,
): 'claude' | 'codex' | null => {
  const sc = env['SCRUMLORD_CLI'];
  if (sc) {
    try {
      return parseAgentProvider(sc);
    } catch {
      // fall through
    }
  }
  return task?.provider ?? null;
};

const resolveProviderSession = (
  flags: Map<string, string[]>,
  env: Environment,
  task: Task | null | undefined,
): { provider: AddTaskProgressInput['provider']; session: AddTaskProgressInput['session'] } => {
  const explicitProvider = flag(flags, 'provider');
  const explicitSession = flag(flags, 'session');

  if (explicitProvider !== undefined && explicitSession !== undefined) {
    return {
      provider: explicitProvider.trim() ? parseAgentProvider(explicitProvider) : null,
      session: explicitSession || null,
    };
  }

  if (explicitProvider !== undefined) {
    const provider = explicitProvider.trim() ? parseAgentProvider(explicitProvider) : null;
    return { provider, session: inferSession(provider, env, task) };
  }

  if (explicitSession !== undefined) {
    const resolvedProvider = resolveProviderForOrphanSession(env, task);
    if (!resolvedProvider) {
      throw new ScrumlordError(
        'orphan_session',
        'tasks progress add --session requires a resolvable provider. Pass --provider <claude|codex>, set SCRUMLORD_CLI, or record a provider on the task first.',
      );
    }
    return { provider: resolvedProvider, session: explicitSession || null };
  }

  const provider = inferProvider(env, task);
  return { provider, session: inferSession(provider, env, task) };
};

/** Resolves provider/session for a `tasks progress add` invocation with strict pairing. */
export const progressInputFromContext = ({
  flags,
  environment,
  task,
}: ProgressFromContextOptions): AddTaskProgressInput => {
  const message = flag(flags, 'message');
  if (!message) throw new ScrumlordError('missing_progress_message', '--message is required.');

  const env = environment ?? Bun.env;
  const { provider, session } = resolveProviderSession(flags, env, task);

  const result: AddTaskProgressInput = { message };
  if (provider !== undefined) result.provider = provider;
  if (session !== undefined) result.session = session;
  return { ...result, ...resolveMetadata(flags, env) };
};
