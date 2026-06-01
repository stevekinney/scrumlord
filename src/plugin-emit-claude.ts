import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  claudeMarketplaceSchema,
  claudePluginManifestSchema,
  validateOrThrow,
} from './plugin-manifest.js';
import { formatJson, formatMarkdown } from './plugin-formatting.js';
import type { PluginSpec } from './plugin-spec.js';

/** JSON Schema URL for editor autocomplete on the Claude plugin manifest. */
const CLAUDE_MANIFEST_SCHEMA_URL = 'https://json.schemastore.org/claude-code-plugin-manifest.json';

/** Builds the YAML frontmatter block for a Claude skill SKILL.md. */
const buildSkillFrontmatter = (description: string): string =>
  `---\ndescription: ${JSON.stringify(description)}\n---\n\n`;

/** Builds the YAML frontmatter block for a Claude agent .md file. */
const buildAgentFrontmatter = (agent: {
  name: string;
  description: string;
  tools: string[];
  color: string;
}): string => {
  const lines = [
    '---',
    `name: ${JSON.stringify(agent.name)}`,
    `description: ${JSON.stringify(agent.description)}`,
    `tools: ${agent.tools.join(', ')}`,
    'skills:',
    '  - tasks',
    `color: ${agent.color}`,
    '---',
    '',
    '',
  ];
  return lines.join('\n');
};

/** Builds the hook command for Claude. */
const buildHookCommand = (): string =>
  'command -v tasks >/dev/null 2>&1 && tasks agent-hook claude || true';

/** Builds the hooks.json structure for Claude from the spec. */
const buildHooks = (spec: PluginSpec): Record<string, unknown> => {
  const command = buildHookCommand();
  const byEvent: Record<string, unknown[]> = {};
  for (const hook of spec.hooks) {
    if (!hook.providers.includes('claude')) continue;
    const entries = (byEvent[hook.event] ??= []);
    const entry: Record<string, unknown> = {
      hooks: [{ type: 'command', command, timeout: 10 }],
    };
    if (hook.matcher) entry['matcher'] = hook.matcher;
    entries.push(entry);
  }
  return { hooks: byEvent };
};

/** Writes the Claude Code plugin tree to `<root>/.claude-plugin/`. */
export const emit = async (spec: PluginSpec, repoRoot: string): Promise<void> => {
  const pluginRoot = join(repoRoot, '.claude-plugin');

  const manifest = {
    $schema: CLAUDE_MANIFEST_SCHEMA_URL,
    name: spec.name,
    displayName: spec.codexInterface.displayName,
    version: spec.version,
    description: spec.description,
    author: spec.author,
    homepage: spec.homepage,
    repository: spec.repository,
    license: spec.license,
    keywords: spec.keywords.length > 0 ? spec.keywords : undefined,
    skills: './skills/',
    agents: './agents/',
    hooks: './hooks/hooks.json',
    mcpServers: './.mcp.json',
  };

  const validManifest = validateOrThrow(
    claudePluginManifestSchema,
    'Claude plugin manifest',
    manifest,
  );

  mkdirSync(pluginRoot, { recursive: true });
  await Bun.write(join(pluginRoot, 'plugin.json'), await formatJson(validManifest));

  // MCP server config (Claude wraps in mcpServers envelope)
  const mcpConfig = {
    mcpServers: {
      [spec.mcp.serverName]: { command: spec.mcp.command, args: spec.mcp.args },
    },
  };
  await Bun.write(join(pluginRoot, '.mcp.json'), await formatJson(mcpConfig));

  // Lifecycle hooks
  const hooks = buildHooks(spec);
  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
  await Bun.write(join(pluginRoot, 'hooks', 'hooks.json'), await formatJson(hooks));

  // Skills
  for (const skill of spec.skills) {
    const body = await Bun.file(skill.sourcePath).text();
    const skillDir = join(pluginRoot, 'skills', skill.name);
    mkdirSync(skillDir, { recursive: true });
    await Bun.write(
      join(skillDir, 'SKILL.md'),
      await formatMarkdown(`${buildSkillFrontmatter(skill.description)}${body}`),
    );
  }

  // Agents — Claude has a dedicated agents/ dir with flat .md files
  mkdirSync(join(pluginRoot, 'agents'), { recursive: true });
  for (const agent of spec.agents) {
    const body = await Bun.file(agent.sourcePath).text();
    await Bun.write(
      join(pluginRoot, 'agents', `${agent.name}.md`),
      await formatMarkdown(`${buildAgentFrontmatter(agent)}${body}`),
    );
  }

  // Local marketplace entry. Claude requires a top-level `owner` object and has
  // no `interface`/`policy` fields (those are Codex-only).
  const marketplace = {
    $schema: 'https://json.schemastore.org/claude-code-plugin-marketplace.json',
    name: `${spec.name}-local`,
    description: spec.description,
    owner: spec.author,
    plugins: [
      {
        name: spec.name,
        // Plugin root == marketplace root == repo root (the dir containing
        // `.claude-plugin/`). Claude resolves relative sources from there.
        source: './',
        description: spec.description,
        category: spec.codexInterface.category,
      },
    ],
  };
  const validMarketplace = validateOrThrow(
    claudeMarketplaceSchema,
    'Claude marketplace manifest',
    marketplace,
  );
  await Bun.write(join(pluginRoot, 'marketplace.json'), await formatJson(validMarketplace));
};
