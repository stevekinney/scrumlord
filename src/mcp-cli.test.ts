import { describe, expect, it } from 'bun:test';
import { runScrumlordMcpCli, scrumlordMcpCliOptionsFromArguments } from './mcp-cli';

describe('tasks-mcp CLI entrypoint', () => {
  it('parses an explicit project root', () => {
    expect(scrumlordMcpCliOptionsFromArguments(['--cwd', '/project'])).toEqual({
      cwd: '/project',
    });
  });

  it('runs the MCP server with parsed options', async () => {
    const errors: string[] = [];
    const exitCode = await runScrumlordMcpCli(['--cwd', '/project'], {
      runServer: async (options) => {
        expect(options.cwd).toBe('/project');
      },
      writeError: (message) => errors.push(message),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
  });

  it('writes startup failures to stderr only', async () => {
    const errors: string[] = [];
    const exitCode = await runScrumlordMcpCli(['--unknown'], {
      runServer: async () => {
        throw new Error('Server should not start.');
      },
      writeError: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(errors.join('')).toContain('Unknown tasks-mcp flag: --unknown.');
  });
});
