#!/usr/bin/env bun
import { runTasksCli } from './cli-runner.js';

const result = await runTasksCli(process.argv.slice(2));

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
