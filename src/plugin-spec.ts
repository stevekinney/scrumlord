import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

export type PluginProvider = 'codex' | 'claude';

export type PluginHookDef = {
  event: string;
  matcher: string | null;
  providers: PluginProvider[];
};

export type PluginSkillDef = {
  name: string;
  description: string;
  /** Absolute path to the source markdown body (no frontmatter). */
  sourcePath: string;
};

export type PluginAgentDef = {
  name: string;
  description: string;
  tools: string[];
  color: string;
  /** Absolute path to the source markdown body (no frontmatter). */
  sourcePath: string;
};

export type PluginAuthor = {
  name: string;
  email?: string;
  url?: string;
};

export type PluginSpec = {
  name: string;
  version: string;
  description: string;
  author: PluginAuthor;
  homepage: string;
  repository: string;
  license: string;
  keywords: string[];
  /** Codex-only: `interface` block for the plugin marketplace listing. */
  codexInterface: {
    displayName: string;
    shortDescription: string;
    longDescription: string;
    developerName: string;
    category: string;
    capabilities: string[];
    websiteURL: string;
    defaultPrompt: string[];
  };
  mcp: {
    serverName: string;
    command: string;
    args: string[];
  };
  skills: PluginSkillDef[];
  agents: PluginAgentDef[];
  hooks: PluginHookDef[];
};

const srcSkillsDir = join(new URL('skills', import.meta.url).pathname);
const authorName = pkg.author ? pkg.author.replace(/\s*<[^>]+>/, '').trim() : 'Steve Kinney';
const authorEmail = (() => {
  const match = pkg.author?.match(/<([^>]+)>/);
  return match ? match[1] : undefined;
})();

/** Canonical Scrumlord plugin spec. Both the Codex and Claude emitters consume this. */
export const scrumlordPluginSpec: PluginSpec = {
  name: 'scrumlord',
  version: pkg.version,
  description: pkg.description,
  author: authorEmail ? { name: authorName, email: authorEmail } : { name: authorName },
  homepage: 'https://github.com/stevekinney/scrumlord',
  repository: 'https://github.com/stevekinney/scrumlord',
  license: pkg.license ?? 'MIT',
  keywords: [],
  codexInterface: {
    displayName: 'Scrumlord',
    shortDescription: 'Local task graph for AI-driven development workflows.',
    longDescription:
      'Scrumlord stores a lightweight task graph in tmp/tasks.db at your project root. ' +
      'Install this plugin to get the tasks skill, the scrumlord-task-manager subagent skill, ' +
      'the MCP server, and lifecycle hooks that inject current-branch task context into every session. ' +
      'Requires the `tasks` binary on PATH (install via `bun add -g scrumlord`).',
    developerName: authorName,
    category: 'Productivity',
    capabilities: ['Read', 'Write'],
    websiteURL: 'https://github.com/stevekinney/scrumlord',
    defaultPrompt: [
      'Use Scrumlord to break this roadmap into a task graph.',
      'Use Scrumlord to show me the next available task.',
      'Use Scrumlord to check pull request readiness.',
    ],
  },
  mcp: {
    serverName: 'scrumlord',
    command: 'bunx',
    args: ['scrumlord', 'tasks-mcp'],
  },
  skills: [
    {
      name: 'tasks',
      description: 'Inspect and update the local Scrumlord task graph.',
      sourcePath: join(srcSkillsDir, 'tasks.md'),
    },
    {
      name: 'committee-review',
      description:
        'Gate PR creation behind a multi-agent review loop: discover subagents, parallel-review the diff, implement feedback, loop until consensus, then open the PR. Trigger on "open a PR", "create a pull request", or "submit for review".',
      sourcePath: join(srcSkillsDir, 'committee-review.md'),
    },
    {
      name: 'address-pr',
      description:
        'Load a pull request, implement review feedback (human and bots), resolve threads, and loop until CI is green and the PR is merge-ready. Trigger on a PR number, PR questions, or fix-it requests.',
      sourcePath: join(srcSkillsDir, 'address-pr.md'),
    },
    {
      name: 'plan-review',
      description:
        "Adversarially review a task's drafted plan with Codex before it is associated and implemented. Loops until Codex approves or the round cap is hit; fail-warns when Codex is unavailable.",
      sourcePath: join(srcSkillsDir, 'plan-review.md'),
    },
  ],
  agents: [
    {
      name: 'scrumlord-task-manager',
      description:
        'Break long documents and task lists into Scrumlord tasks, set dependencies, and check Scrumlord setup.',
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
      color: 'orange',
      sourcePath: join(srcSkillsDir, 'scrumlord-task-manager.md'),
    },
  ],
  hooks: [
    // Claude-only events
    { event: 'PostToolUse', matcher: 'ExitPlanMode', providers: ['claude'] },
    { event: 'SessionEnd', matcher: null, providers: ['claude'] },
    { event: 'SubagentStop', matcher: null, providers: ['claude'] },
    // Shared events
    { event: 'SessionStart', matcher: 'startup|resume', providers: ['codex', 'claude'] },
    { event: 'UserPromptSubmit', matcher: null, providers: ['codex', 'claude'] },
    { event: 'PostToolUse', matcher: 'Bash', providers: ['codex', 'claude'] },
    { event: 'Stop', matcher: null, providers: ['codex', 'claude'] },
  ],
};
