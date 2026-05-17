import { describe, expect, it } from 'bun:test';
import { renderReadiness, type DataShape } from './output-contracts.js';
import { formatJson } from './output-json.js';
import { createRenderContext, renderers, renderPretty } from './output-renderer.js';

const shapes = Object.keys(renderReadiness) as DataShape[];

describe('renderer readiness exhaustiveness', () => {
  it('every implemented shape has a registered renderer', () => {
    for (const shape of shapes) {
      if (renderReadiness[shape] === 'implemented') {
        expect(renderers[shape]).toBeDefined();
      }
    }
  });

  it('every jsonFallback shape has no registered renderer', () => {
    for (const shape of shapes) {
      if (renderReadiness[shape] === 'jsonFallback') {
        expect(renderers[shape]).toBeUndefined();
      }
    }
  });
});

describe('renderPretty', () => {
  const context = createRenderContext({
    colorMode: 'never',
    terminalWidth: 80,
    flags: new Set(),
  });

  it('falls back to JSON when no renderer is registered for the shape', () => {
    for (const shape of shapes) {
      if (renderReadiness[shape] === 'jsonFallback') {
        const value = { example: shape };
        expect(renderPretty(shape, value, context)).toBe(formatJson(value));
      }
    }
  });
});

describe('createRenderContext', () => {
  it('defaults terminal width to 100', () => {
    const context = createRenderContext({ colorMode: 'never', flags: new Set() });
    expect(context.terminalWidth).toBe(100);
  });

  it('preserves explicit terminal width and countLabel', () => {
    const context = createRenderContext({
      colorMode: 'never',
      terminalWidth: 42,
      flags: new Set(['count']),
      countLabel: 'matching tasks',
    });
    expect(context.terminalWidth).toBe(42);
    expect(context.countLabel).toBe('matching tasks');
    expect(context.flags.has('count')).toBe(true);
  });
});
