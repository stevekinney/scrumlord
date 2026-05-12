#!/usr/bin/env bun
import { errorMessage, ScrumlordError } from './errors.js';
import { runScrumlordMcpServer, type ScrumlordMcpServerOptions } from './mcp-server.js';

export type ScrumlordMcpCliRunOptions = {
  runServer?: (options: ScrumlordMcpServerOptions) => Promise<void>;
  writeError?: (message: string) => void;
};

/** Parses arguments for the local stdio MCP server entrypoint. */
export const scrumlordMcpCliOptionsFromArguments = (argv: string[]): ScrumlordMcpServerOptions => {
  const options: ScrumlordMcpServerOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--cwd') {
      const cwd = argv[index + 1];
      if (!cwd || cwd.startsWith('--')) {
        throw new ScrumlordError('missing_flag_value', '--cwd requires a value.');
      }
      options.cwd = cwd;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--')) {
      throw new ScrumlordError('unknown_flag', `Unknown tasks-mcp flag: ${argument}.`);
    }
    throw new ScrumlordError('unexpected_argument', `Unexpected tasks-mcp argument: ${argument}.`);
  }

  return options;
};

/** Runs the tasks-mcp CLI wrapper and maps startup failures to stderr-only output. */
export const runScrumlordMcpCli = async (
  argv: string[],
  options: ScrumlordMcpCliRunOptions = {},
): Promise<number> => {
  try {
    const serverOptions = scrumlordMcpCliOptionsFromArguments(argv);
    await (options.runServer ?? runScrumlordMcpServer)(serverOptions);
    return 0;
  } catch (error) {
    const writeError = options.writeError ?? ((message: string) => process.stderr.write(message));
    writeError(`${errorMessage(error)}\n`);
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await runScrumlordMcpCli(process.argv.slice(2));
}
