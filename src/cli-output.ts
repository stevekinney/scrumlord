import type { ParsedArguments } from './cli-arguments.js';
import type { CliOptions, CliResult } from './cli-types.js';
import {
  contractForInvocation,
  rejectJsonOnNonDataContract,
  type OutputContract,
} from './output-contracts.js';
import { formatJson } from './output-json.js';
import { resolveOutputMode, type OutputMode } from './output-mode.js';
import { createRenderContext, renderPretty } from './output-renderer.js';
import { ScrumlordError } from './errors.js';

/**
 * Resolves the {@link OutputContract} for a parsed command + flags. The
 * `progress` command's add/list split lives in its positionals, so a
 * synthetic flag (`subcommand:add` / `subcommand:list`) is injected before
 * dispatch.
 */
export const contractForParsed = (parsed: ParsedArguments): OutputContract => {
  const flags = new Set(parsed.flags.keys());
  if (parsed.command === 'progress') {
    const subcommand = parsed.positionals[0];
    if (subcommand === 'add') flags.add('subcommand:add');
    if (subcommand === 'list') flags.add('subcommand:list');
  }
  return contractForInvocation(parsed.command ?? '', flags);
};

/** Computes the resolved {@link OutputMode} for the given parsed command. */
export const resolveModeForOptions = (parsed: ParsedArguments, options: CliOptions): OutputMode => {
  if (options.outputMode !== undefined) return options.outputMode;
  return resolveOutputMode({
    jsonFlag: parsed.flags.has('json'),
    environment: options.environment ?? {},
    isTty: options.isStdoutTty ?? false,
  });
};

/**
 * Throws `json_not_supported` when `--json` is passed on an invocation whose
 * contract has no JSON form. Swallows `unknown_command` from the contract
 * lookup because the runner's own unknown-command path produces a better
 * error.
 */
export const rejectJsonOnRawForm = (parsed: ParsedArguments): void => {
  if (!parsed.command) return;
  try {
    const flags = new Set(parsed.flags.keys());
    if (parsed.command === 'progress') {
      const subcommand = parsed.positionals[0];
      if (subcommand === 'add') flags.add('subcommand:add');
      if (subcommand === 'list') flags.add('subcommand:list');
    }
    rejectJsonOnNonDataContract(parsed.command, flags);
  } catch (error) {
    if (error instanceof ScrumlordError && error.code === 'json_not_supported') throw error;
  }
};

const renderContextFor = (
  parsed: ParsedArguments,
  options: CliOptions,
  contract: OutputContract,
): ReturnType<typeof createRenderContext> => {
  const countLabel = contract.kind === 'jsonData' ? contract.countLabel : undefined;
  return createRenderContext({
    colorMode: options.colorMode ?? 'auto',
    ...(options.terminalWidth !== undefined ? { terminalWidth: options.terminalWidth } : {}),
    flags: new Set(parsed.flags.keys()),
    ...(countLabel !== undefined ? { countLabel } : {}),
  });
};

const jsonResult = (value: unknown): CliResult => ({
  exitCode: 0,
  stdout: formatJson(value),
  stderr: '',
});

/**
 * Formats a store command's return value as a {@link CliResult}. Routes
 * through the pretty renderer when the resolved mode is `'pretty'` and the
 * shape has an implemented renderer; otherwise emits JSON byte-for-byte.
 */
export const formatStoreResult = (
  parsed: ParsedArguments,
  value: unknown,
  options: CliOptions,
): CliResult => {
  const mode = options.outputMode ?? 'json';
  if (mode === 'json') return jsonResult(value);
  let contract: OutputContract;
  try {
    contract = contractForParsed(parsed);
  } catch {
    return jsonResult(value);
  }
  if (contract.kind !== 'jsonData') return jsonResult(value);
  const context = renderContextFor(parsed, options, contract);
  return { exitCode: 0, stdout: renderPretty(contract.shape, value, context), stderr: '' };
};
