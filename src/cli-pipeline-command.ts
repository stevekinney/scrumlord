import { flag, type ParsedArguments } from './cli-arguments.js';
import type { CliOptions, CliResult } from './cli-types.js';
import { ScrumlordError } from './errors.js';
import { runPipeline, type PipelineMode, type PipelineOptions } from './pipeline.js';
import type { AgentProvider, TaskStore } from './types.js';
import { parseAgentProvider } from './validation.js';

const resolveProvider = (parsed: ParsedArguments, options: CliOptions): AgentProvider => {
  const provided =
    flag(parsed.flags, 'cli') ?? options.environment?.['SCRUMLORD_CLI'] ?? Bun.env['SCRUMLORD_CLI'];
  if (!provided) {
    throw new ScrumlordError(
      'scrumlord_cli_required',
      'tasks pipeline requires --cli or SCRUMLORD_CLI.',
    );
  }
  return parseAgentProvider(provided);
};

const resolveMode = (parsed: ParsedArguments): PipelineMode => {
  const resume = flag(parsed.flags, 'resume');
  if (resume) return 'resume';
  if (parsed.flags.has('recover-then-run')) return 'recover-then-run';
  if (parsed.flags.has('recover')) return 'recover';
  return 'drain';
};

const resolveMax = (parsed: ParsedArguments): number | undefined => {
  const raw = flag(parsed.flags, 'max');
  if (raw === undefined) return undefined;
  const parsedNumber = Number(raw);
  if (!Number.isFinite(parsedNumber) || !Number.isInteger(parsedNumber) || parsedNumber < 1) {
    throw new ScrumlordError(
      'pipeline_max_invalid',
      `--max must be a positive integer (got ${raw}).`,
    );
  }
  return parsedNumber;
};

/** CLI entry point for `tasks pipeline`. Routes parsed flags into the pipeline driver. */
export const runPipelineCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const provider = resolveProvider(parsed, options);
  const mode = resolveMode(parsed);
  const max = resolveMax(parsed);
  const resumeTaskId = flag(parsed.flags, 'resume');
  const pipelineOptions: PipelineOptions = {
    provider,
    mode,
    apply: parsed.flags.has('apply'),
    quiet: parsed.flags.has('quiet'),
    dryRun: parsed.flags.has('dry-run'),
  };
  if (max !== undefined) pipelineOptions.max = max;
  if (resumeTaskId !== undefined) pipelineOptions.resumeTaskId = resumeTaskId;
  if (options.runner !== undefined) pipelineOptions.runner = options.runner;
  const summary = await runPipeline(store, pipelineOptions);
  if (parsed.flags.has('json')) {
    return {
      exitCode: summary.exitCode,
      stdout: `${JSON.stringify(summary, null, 2)}\n`,
      stderr: '',
    };
  }
  return { exitCode: summary.exitCode, stdout: '', stderr: '' };
};
