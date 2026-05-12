import { flag } from './cli-arguments.js';
import { ScrumlordError } from './errors.js';
import type { AddTaskProgressInput } from './types.js';
import { parseAgentProvider } from './validation.js';

export const progressInputFromFlags = (flags: Map<string, string[]>): AddTaskProgressInput => {
  const message = flag(flags, 'message');
  if (!message) throw new ScrumlordError('missing_progress_message', '--message is required.');

  const input: AddTaskProgressInput = { message };
  const provider = flag(flags, 'provider');
  if (provider !== undefined)
    input.provider = provider.trim() ? parseAgentProvider(provider) : null;
  const session = flag(flags, 'session');
  if (session !== undefined) input.session = session;
  return input;
};
