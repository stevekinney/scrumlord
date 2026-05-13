import type { TaskIdentifier } from './types.js';

/**
 * Phases the pipeline writes to task progress as machine-readable markers.
 * Recovery and ownership checks parse only entries matching this format.
 */
export const pipelinePhases = [
  'claim',
  'branch-set',
  'agent-exited',
  'pr-created',
  'in-review',
  'address-pr',
  'merge',
  'interrupted',
] as const;
export type PipelinePhase = (typeof pipelinePhases)[number];

const MARKER_PREFIX = 'pipeline:phase=';

/** Builds a canonical `pipeline:phase=<phase>;task=<id>;run=<run>;at=<iso>` marker. */
export const formatPipelinePhaseMarker = (
  phase: PipelinePhase,
  taskId: TaskIdentifier,
  runId: string,
  at: string,
): string => {
  return `${MARKER_PREFIX}${phase};task=${taskId};run=${runId};at=${at}`;
};

export type ParsedPipelineMarker = {
  phase: PipelinePhase;
  taskId: TaskIdentifier;
  runId: string;
  at: string;
};

/** Parses a canonical marker. Returns null when the message is not a pipeline marker. */
export const parsePipelineMarker = (message: string): ParsedPipelineMarker | null => {
  if (!message.startsWith(MARKER_PREFIX)) return null;
  const body = message.slice('pipeline:'.length); // strip the literal "pipeline:" prefix
  const fields = new Map<string, string>();
  for (const piece of body.split(';')) {
    const equals = piece.indexOf('=');
    if (equals === -1) continue;
    fields.set(piece.slice(0, equals), piece.slice(equals + 1));
  }
  const phase = fields.get('phase');
  const taskId = fields.get('task');
  const runId = fields.get('run');
  const at = fields.get('at');
  if (!phase || !taskId || !runId || !at) return null;
  if (!isPipelinePhase(phase)) return null;
  return { phase, taskId, runId, at };
};

/** Extracts the `run` id from a marker without forcing the caller to validate every field. */
export const parsePipelineRunId = (message: string): string | null => {
  const parsed = parsePipelineMarker(message);
  return parsed?.runId ?? null;
};

const isPipelinePhase = (value: string): value is PipelinePhase => {
  return (pipelinePhases as readonly string[]).includes(value);
};
