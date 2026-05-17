import { createTheme, type ColorMode, type Theme } from './color.js';
import { formatJson } from './output-json.js';
import { renderReadiness, type DataShape } from './output-contracts.js';

/** Context passed to every pretty renderer. */
export type RenderContext = {
  theme: Theme;
  colorMode: ColorMode;
  terminalWidth: number;
  flags: ReadonlySet<string>;
  countLabel?: string;
};

/** Construction helper. Keeps boundary defaults (width 100) in one place. */
export const createRenderContext = (input: {
  colorMode: ColorMode;
  terminalWidth?: number;
  flags: ReadonlySet<string>;
  countLabel?: string;
}): RenderContext => ({
  theme: createTheme(input.colorMode),
  colorMode: input.colorMode,
  terminalWidth: input.terminalWidth ?? 100,
  flags: input.flags,
  ...(input.countLabel !== undefined ? { countLabel: input.countLabel } : {}),
});

type PrettyRenderer = (value: unknown, context: RenderContext) => string;

/**
 * Registry of implemented pretty renderers. Phase A ships with none; later
 * phases add entries here and flip the corresponding `renderReadiness` entry
 * to `'implemented'` in the same commit.
 *
 * The exhaustiveness test enforces the lockstep: every `'implemented'` shape
 * has a renderer; every `'jsonFallback'` shape does not.
 */
export const renderers: Partial<Record<DataShape, PrettyRenderer>> = {};

/**
 * Dispatches a value to its pretty renderer when one is registered; otherwise
 * silently falls back to JSON. The readiness map plus the exhaustiveness test
 * prevent silent drift — runtime never logs.
 */
export const renderPretty = (shape: DataShape, value: unknown, context: RenderContext): string => {
  const renderer = renderers[shape];
  if (!renderer) return formatJson(value);
  return renderer(value, context);
};

/** Re-exported so callers can branch on readiness without importing both modules. */
export { renderReadiness };
