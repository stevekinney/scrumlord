import type { ParsedArguments } from './cli-arguments.js';
import { ScrumlordError } from './errors.js';
import type { CliResult } from './cli-types.js';
import type { TaskStore } from './types.js';

/** Handles the internal `tasks completions-data <ids|tags>` command. */
export const runCompletionsDataCommand = (store: TaskStore, parsed: ParsedArguments): CliResult => {
  const target = parsed.positionals[0];

  if (target === 'ids') {
    const ids = store.allIds();
    return { exitCode: 0, stdout: ids.length > 0 ? `${ids.join('\n')}\n` : '', stderr: '' };
  }

  if (target === 'tags') {
    const tags = store.allTags();
    return { exitCode: 0, stdout: tags.length > 0 ? `${tags.join('\n')}\n` : '', stderr: '' };
  }

  throw new ScrumlordError(
    'unknown_completions_data_target',
    `Unknown completions-data target: ${target}. Supported targets: ids, tags.`,
  );
};
