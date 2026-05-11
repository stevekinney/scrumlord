export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (command: string[], cwd: string) => Promise<CommandResult>;

/** Runs a command with Bun's native process API and captures stdout/stderr as text. */
export const runCommand: CommandRunner = async (command, cwd) => {
  try {
    const subprocess = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);

    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};
