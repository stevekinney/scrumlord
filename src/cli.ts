#!/usr/bin/env bun
import { runTasksCli } from './cli-runner.js';

const columns = process.stdout.columns;
const result = await runTasksCli(process.argv.slice(2), {
  environment: process.env,
  isStdoutTty: process.stdout.isTTY === true,
  ...(typeof columns === 'number' ? { terminalWidth: columns } : {}),
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
