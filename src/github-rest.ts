import { runCommand, type CommandResult, type CommandRunner } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import {
  gitHubRestCacheKey,
  readGitHubRestCache,
  writeGitHubRestCache,
  type GitHubRestCache,
  type GitHubRestCacheEntry,
} from './github-rest-cache.js';

type GitHubRestOptions = {
  runner?: CommandRunner;
};

type GitHubRestRequest = {
  projectRoot: string;
  endpoint: string;
  parameters: Record<string, string>;
  options: GitHubRestOptions | undefined;
  failureCode: string;
};

type GitHubRestResponseContext = GitHubRestRequest & {
  cache: GitHubRestCache;
  cachedEntry: GitHubRestCacheEntry | undefined;
  useCache: boolean;
};

export type IncludedGitHubApiResponse = {
  status: number;
  headers: Record<string, string>;
  body: string | null;
};

export const parseIncludedGitHubApiResponse = (stdout: string): IncludedGitHubApiResponse => {
  const normalized = stdout.replaceAll('\r\n', '\n');
  const separatorIndex = normalized.indexOf('\n\n');
  if (separatorIndex === -1) {
    throw new ScrumlordError(
      'github_response_invalid',
      'Expected gh api --include output to contain headers and a body separator.',
    );
  }

  const headerText = normalized.slice(0, separatorIndex);
  const body = normalized.slice(separatorIndex + 2);
  const [statusLine, ...headerLines] = headerText.split('\n');
  const statusMatch = statusLine?.match(/^HTTP\/\S+\s+(\d{3})\b/);
  if (!statusMatch) {
    throw new ScrumlordError(
      'github_response_invalid',
      'Expected gh api --include output to start with an HTTP status line.',
    );
  }

  return {
    status: Number(statusMatch[1]),
    headers: headersFromLines(headerLines),
    body: body.trim() ? body : null,
  };
};

const headersFromLines = (lines: string[]): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
};

const parseGitHubRestJson = (body: string | null, context: string): unknown => {
  if (!body) {
    throw new ScrumlordError('github_response_invalid', `Expected ${context} to return JSON.`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ScrumlordError('github_json_parse_failed', `Could not parse JSON from ${context}.`);
  }
};

const execute = async (
  command: string[],
  cwd: string,
  options: GitHubRestOptions | undefined,
): Promise<CommandResult> => {
  return await (options?.runner ?? runCommand)(command, cwd);
};

const restCommand = (
  endpoint: string,
  parameters: Record<string, string>,
  etag: string | undefined,
): string[] => {
  const command = ['gh', 'api', '--include', '--method', 'GET', endpoint];
  for (const [key, value] of Object.entries(parameters).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    command.push('-F', `${key}=${value}`);
  }
  if (etag) command.push('-H', `If-None-Match: ${etag}`);
  return command;
};

const isIncludedResponse = (stdout: string): boolean => {
  return /^HTTP\/\S+\s+\d{3}\b/.test(stdout.trimStart());
};

const cachedBodyOrRetry = async (context: GitHubRestResponseContext): Promise<unknown> => {
  if (context.cachedEntry && 'body' in context.cachedEntry) return context.cachedEntry.body;
  return await runGitHubRestGet(
    context.projectRoot,
    context.endpoint,
    context.parameters,
    context.options,
    context.failureCode,
    false,
  );
};

const cacheResponseBody = async (
  context: GitHubRestResponseContext,
  body: unknown,
  etag: string | undefined,
): Promise<void> => {
  if (!context.useCache || !etag) return;
  context.cache[gitHubRestCacheKey(context.endpoint, context.parameters)] = {
    etag,
    body,
    updatedAt: new Date().toISOString(),
  };
  await writeGitHubRestCache(context.projectRoot, context.cache);
};

const jsonFromIncludedResult = async (
  result: CommandResult,
  context: GitHubRestResponseContext,
): Promise<unknown> => {
  if (result.exitCode !== 0 && !isIncludedResponse(result.stdout)) {
    throw new ScrumlordError(context.failureCode, result.stderr.trim());
  }

  const response = parseIncludedGitHubApiResponse(result.stdout);
  if (response.status === 304) return await cachedBodyOrRetry(context);
  if (response.status < 200 || response.status >= 300) {
    throw new ScrumlordError(context.failureCode, result.stderr.trim());
  }

  const body = parseGitHubRestJson(response.body, `gh api ${context.endpoint}`);
  await cacheResponseBody(context, body, response.headers['etag']);
  return body;
};

export const runGitHubRestGet = async (
  projectRoot: string,
  endpoint: string,
  parameters: Record<string, string>,
  options: GitHubRestOptions | undefined,
  failureCode: string,
  useCache = true,
): Promise<unknown> => {
  const cache = useCache ? await readGitHubRestCache(projectRoot) : {};
  const cachedEntry = cache[gitHubRestCacheKey(endpoint, parameters)];
  const result = await execute(
    restCommand(endpoint, parameters, cachedEntry?.etag),
    projectRoot,
    options,
  );

  return await jsonFromIncludedResult(result, {
    projectRoot,
    endpoint,
    parameters,
    options,
    failureCode,
    cache,
    cachedEntry,
    useCache,
  });
};
