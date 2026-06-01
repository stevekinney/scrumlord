import { format } from 'prettier';

export const formatJson = (value: unknown): Promise<string> =>
  format(JSON.stringify(value), { parser: 'json' });

export const formatMarkdown = (value: string): Promise<string> =>
  format(value, {
    parser: 'markdown',
    singleQuote: true,
    printWidth: 100,
    tabWidth: 2,
    endOfLine: 'lf',
  });
