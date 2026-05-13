import { describe, expect, it } from 'bun:test';
import { parseArguments } from './cli-arguments';
import { runPipelineCommand } from './cli-pipeline-command';
import type { TaskStore } from './types';

/**
 * Minimal stub that satisfies the `--once` argument resolution path. The real
 * pipeline orchestrator never runs in these tests; we stop at the runner call
 * by throwing a sentinel error from the runner and inspecting it.
 */
const sentinelStore: TaskStore = {} as unknown as TaskStore;

const captureRunPipelineMax = async (argv: string[]): Promise<{ thrown: Error | null }> => {
  const parsed = parseArguments(argv);
  // runPipelineCommand validates --once/--max BEFORE touching the store, so
  // we can observe the right error code synchronously. Anything else throws
  // downstream against the empty `sentinelStore` stub.
  try {
    await runPipelineCommand(sentinelStore, parsed, {
      environment: { SCRUMLORD_CLI: 'claude' },
    });
  } catch (error) {
    return { thrown: error as Error };
  }
  return { thrown: null };
};

describe('runPipelineCommand --once', () => {
  it('throws pipeline_once_conflict when --once and --max <n> are both set with n !== 1', async () => {
    const { thrown } = await captureRunPipelineMax(['pipeline', '--once', '--max', '3']);
    expect((thrown as { code?: string } | null)?.code).toBe('pipeline_once_conflict');
  });

  it('accepts --once with --max 1 (redundant but not a conflict)', async () => {
    const { thrown } = await captureRunPipelineMax(['pipeline', '--once', '--max', '1']);
    // We expect downstream errors (no store) but NOT the conflict code.
    expect((thrown as { code?: string } | null)?.code).not.toBe('pipeline_once_conflict');
  });

  it('rejects --max 0 with pipeline_max_invalid', async () => {
    const { thrown } = await captureRunPipelineMax(['pipeline', '--max', '0']);
    expect((thrown as { code?: string } | null)?.code).toBe('pipeline_max_invalid');
  });
});
