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

const formatMarkdown = (value: string): Promise<string> =>
  format(value, {
    parser: 'markdown',
    singleQuote: true,
    printWidth: 100,
    tabWidth: 2,
    endOfLine: 'lf',
  });

/** Builds the YAML frontmatter block for a Codex skill SKILL.md. */
const buildFrontmatter = (name: string, description: string): string =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;

/**
 * Writes the Codex plugin tree under `<root>/.codex-plugin/`.
 *
 * `.codex-plugin/` is the Codex *marketplace root*: it holds
 * `.agents/plugins/marketplace.json` plus a `plugins/<name>/` directory for each
 * plugin. The plugin itself lives at `plugins/<name>/`, with its manifest under
 * `plugins/<name>/.codex-plugin/`, so that the
 * marketplace `source.path` (`./plugins/<name>`) resolves to a directory that
 * contains a `.codex-plugin/plugin.json` — the layout `codex plugin add`
 * requires. A self-referential `source.path` of `.` is rejected by Codex, which
 * is why the plugin is nested under `plugins/` rather than living at the root.
 */
export const emit = async (spec: PluginSpec, repoRoot: string): Promise<void> => {
  const marketplaceRoot = join(repoRoot, '.codex-plugin');
  const pluginRoot = join(marketplaceRoot, 'plugins', spec.name);
  const manifestRoot = join(pluginRoot, '.codex-plugin');

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
    interface: spec.codexInterface,
  };

  const validManifest = validateOrThrow(pluginManifestSchema, 'Codex plugin manifest', manifest);

  mkdirSync(manifestRoot, { recursive: true });
  await Bun.write(join(manifestRoot, 'plugin.json'), await formatJson(validManifest));

  // MCP server config. Codex component paths are resolved from the plugin root,
  // and the MCP companion file uses the same `mcpServers` envelope as bundled
  // Codex plugins.
  const mcpConfig: Record<string, unknown> = {
    mcpServers: {
      [spec.mcp.serverName]: { command: spec.mcp.command, args: spec.mcp.args },
    },
  };
  await Bun.write(join(pluginRoot, '.mcp.json'), await formatJson(mcpConfig));

  // Skills
  for (const skill of spec.skills) {
    const body = await Bun.file(skill.sourcePath).text();
    const skillDir = join(pluginRoot, 'skills', skill.name);
    mkdirSync(skillDir, { recursive: true });
    await Bun.write(
      join(skillDir, 'SKILL.md'),
      await formatMarkdown(`${buildFrontmatter(skill.name, skill.description)}${body}`),
    );
  }

  // Codex: agents are also shipped as skills (Codex has no separate agents/ dir)
  for (const agent of spec.agents) {
    const body = await Bun.file(agent.sourcePath).text();
    const skillDir = join(pluginRoot, 'skills', agent.name);
    mkdirSync(skillDir, { recursive: true });
    await Bun.write(
      join(skillDir, 'SKILL.md'),
      await formatMarkdown(`${buildFrontmatter(agent.name, agent.description)}${body}`),
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
