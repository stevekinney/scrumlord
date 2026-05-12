export type ColorMode = 'auto' | 'always' | 'never';

type Formatter = (value: string) => string;

export type Theme = {
  title: Formatter;
  heading: Formatter;
  command: Formatter;
  option: Formatter;
  argument: Formatter;
  muted: Formatter;
  success: Formatter;
  warning: Formatter;
  error: Formatter;
};

const reset = '\u001b[0m';

const colorEnabled = (mode: ColorMode): boolean => {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  if (Bun.env['NO_COLOR'] !== undefined) return false;
  return true;
};

const ansi = (color: string, mode: ColorMode): string => {
  if (!colorEnabled(mode)) return '';
  const format = mode === 'always' || Bun.env['FORCE_COLOR'] !== undefined ? 'ansi-16m' : 'ansi';
  return Bun.color(color, format) ?? '';
};

const formatter = (color: string, mode: ColorMode): Formatter => {
  return (value) => {
    const sequence = ansi(color, mode);
    return sequence ? `${sequence}${value}${reset}` : value;
  };
};

/** Creates the color theme used for human-facing CLI output. */
export const createTheme = (mode: ColorMode = 'auto'): Theme => ({
  title: formatter('#f97316', mode),
  heading: formatter('#38bdf8', mode),
  command: formatter('#a78bfa', mode),
  option: formatter('#22c55e', mode),
  argument: formatter('#facc15', mode),
  muted: formatter('#94a3b8', mode),
  success: formatter('#10b981', mode),
  warning: formatter('#f59e0b', mode),
  error: formatter('#ef4444', mode),
});
