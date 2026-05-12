import { afterEach, describe, expect, it } from 'bun:test';
import { createTheme } from './color';

const ansiStart = `${String.fromCharCode(27)}[`;
const originalNoColor = Bun.env.NO_COLOR;
const originalForceColor = Bun.env.FORCE_COLOR;

afterEach(() => {
  Bun.env.NO_COLOR = originalNoColor;
  Bun.env.FORCE_COLOR = originalForceColor;
});

describe('createTheme', () => {
  it('can force color for deterministic human output', () => {
    expect(createTheme('always').command('tasks')).toContain(ansiStart);
  });

  it('can disable color explicitly', () => {
    expect(createTheme('never').command('tasks')).toBe('tasks');
  });

  it('honors NO_COLOR in automatic mode', () => {
    Bun.env.NO_COLOR = '1';

    expect(createTheme('auto').command('tasks')).toBe('tasks');
  });

  it('uses Bun terminal color detection in automatic mode', () => {
    delete Bun.env.NO_COLOR;
    Bun.env.FORCE_COLOR = '1';

    expect(createTheme('auto').command('tasks')).toContain(ansiStart);
  });
});
