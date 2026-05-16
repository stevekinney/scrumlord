import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pluginManifestSchema } from './plugin-manifest.js';
import type { PluginSpec } from './plugin-spec.js';

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

/** Writes the Codex plugin tree to `<root>/.codex-plugin/`. */
export const emit = async (spec: PluginSpec, repoRoot: string): Promise<void> => {
  const pluginRoot = join(repoRoot, '.codex-plugin');

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

  const parsed = pluginManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => ` - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Codex plugin manifest validation failed:\n${issues}`);
  }

  mkdirSync(pluginRoot, { recursive: true });
  await Bun.write(join(pluginRoot, 'plugin.json'), `${JSON.stringify(parsed.data, null, 2)}\n`);

  // MCP server config (Codex uses a flat server map)
  const mcpConfig: Record<string, unknown> = {
    [spec.mcp.serverName]: { command: spec.mcp.command, args: spec.mcp.args },
  };
  await Bun.write(join(pluginRoot, '.mcp.json'), `${JSON.stringify(mcpConfig, null, 2)}\n`);

  // Lifecycle hooks
  const hooks = buildHooks(spec);
  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
  await Bun.write(join(pluginRoot, 'hooks', 'hooks.json'), `${JSON.stringify(hooks, null, 2)}\n`);

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
};
