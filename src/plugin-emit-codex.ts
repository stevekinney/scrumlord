import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'prettier';
import {
  codexMarketplaceSchema,
  pluginManifestSchema,
  validateOrThrow,
} from './plugin-manifest.js';
import type { PluginSpec } from './plugin-spec.js';

const formatJson = (value: unknown): Promise<string> =>
  format(JSON.stringify(value), { parser: 'json' });

/** Builds the YAML frontmatter block for a Codex skill SKILL.md. */
const buildFrontmatter = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n`;

/** Builds the hook command for Codex. */
const buildHookCommand = (): string =>
  'command -v tasks >/dev/null 2>&1 && tasks agent-hook codex || true';

/** Builds the hooks.json structure for Codex from the spec. */
const buildHooks = (spec: PluginSpec): Record<string, unknown> => {
  const command = buildHookCommand();
  const byEvent: Record<string, unknown[]> = {};
  for (const hook of spec.hooks) {
    if (!hook.providers.includes('codex')) continue;
    const entries = (byEvent[hook.event] ??= []);
    const entry: Record<string, unknown> = {
      hooks: [{ type: 'command', command, timeout: 10 }],
    };
    if (hook.matcher) entry['matcher'] = hook.matcher;
    entries.push(entry);
  }
  return { hooks: byEvent };
};

/**
 * Writes the Codex plugin tree under `<root>/.codex-plugin/`.
 *
 * `.codex-plugin/` is the Codex *marketplace root*: it holds
 * `.agents/plugins/marketplace.json` plus a `plugins/<name>/` directory for each
 * plugin. The plugin itself lives at `plugins/<name>/.codex-plugin/` so that the
 * marketplace `source.path` (`./plugins/<name>`) resolves to a directory that
 * contains a `.codex-plugin/plugin.json` — the layout `codex plugin add`
 * requires. A self-referential `source.path` of `.` is rejected by Codex, which
 * is why the plugin is nested under `plugins/` rather than living at the root.
 */
export const emit = async (spec: PluginSpec, repoRoot: string): Promise<void> => {
  const marketplaceRoot = join(repoRoot, '.codex-plugin');
  const pluginRoot = join(marketplaceRoot, 'plugins', spec.name, '.codex-plugin');

  const manifest = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    author: spec.author,
    homepage: spec.homepage,
    repository: spec.repository,
    license: spec.license,
    keywords: spec.keywords.length > 0 ? spec.keywords : undefined,
    skills: './skills/',
    mcpServers: './.mcp.json',
    hooks: './hooks/hooks.json',
    interface: spec.codexInterface,
  };

  const validManifest = validateOrThrow(pluginManifestSchema, 'Codex plugin manifest', manifest);

  mkdirSync(pluginRoot, { recursive: true });
  await Bun.write(join(pluginRoot, 'plugin.json'), await formatJson(validManifest));

  // MCP server config (Codex uses a flat server map)
  const mcpConfig: Record<string, unknown> = {
    [spec.mcp.serverName]: { command: spec.mcp.command, args: spec.mcp.args },
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
      `${buildFrontmatter(skill.name, skill.description)}${body}`,
    );
  }

  // Codex: agents are also shipped as skills (Codex has no separate agents/ dir)
  for (const agent of spec.agents) {
    const body = await Bun.file(agent.sourcePath).text();
    const skillDir = join(pluginRoot, 'skills', agent.name);
    mkdirSync(skillDir, { recursive: true });
    await Bun.write(
      join(skillDir, 'SKILL.md'),
      `${buildFrontmatter(agent.name, agent.description)}${body}`,
    );
  }

  // Codex marketplace manifest. Codex loads marketplaces from
  // `<marketplace-root>/.agents/plugins/marketplace.json` and resolves each
  // plugin's `source.path` relative to that root. Here the marketplace root is
  // `.codex-plugin/`, and the plugin sits at `./plugins/<name>` (which contains
  // its own `.codex-plugin/plugin.json`).
  const marketplace = {
    name: `${spec.name}-local`,
    interface: { displayName: spec.codexInterface.displayName },
    plugins: [
      {
        name: spec.name,
        source: { source: 'local' as const, path: `./plugins/${spec.name}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: spec.codexInterface.category,
      },
    ],
  };
  const validMarketplace = validateOrThrow(
    codexMarketplaceSchema,
    'Codex marketplace manifest',
    marketplace,
  );
  const marketplaceDir = join(marketplaceRoot, '.agents', 'plugins');
  mkdirSync(marketplaceDir, { recursive: true });
  await Bun.write(join(marketplaceDir, 'marketplace.json'), await formatJson(validMarketplace));
};
