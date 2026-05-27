import { z } from 'zod';

/**
 * Parse `value` against `schema`, returning the typed result or throwing an
 * error whose message lists every validation issue. Shared by both emitters so
 * generated plugin and marketplace manifests fail loudly at build time.
 */
export const validateOrThrow = <T>(schema: z.ZodType<T>, label: string, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => ` - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`${label} validation failed:\n${issues}`);
  }
  return parsed.data;
};

const pluginAuthorSchema = z.object({
  name: z.string(),
  email: z.string().optional(),
  url: z.string().optional(),
});

const pluginInterfaceSchema = z.object({
  displayName: z.string(),
  shortDescription: z.string(),
  longDescription: z.string().optional(),
  developerName: z.string().optional(),
  category: z.string(),
  capabilities: z.array(z.string()).optional(),
  websiteURL: z.string().optional(),
  privacyPolicyURL: z.string().optional(),
  termsOfServiceURL: z.string().optional(),
  defaultPrompt: z.array(z.string()).optional(),
  brandColor: z.string().optional(),
  composerIcon: z.string().optional(),
  logo: z.string().optional(),
  screenshots: z.array(z.string()).optional(),
});

const pluginBaseSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Plugin name must be kebab-case'),
  version: z.string(),
  description: z.string(),
  author: pluginAuthorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

/** Zod schema for a Codex plugin manifest (.codex-plugin/plugin.json). */
export const pluginManifestSchema = pluginBaseSchema.extend({
  skills: z.string().optional(),
  mcpServers: z.string().optional(),
  apps: z.string().optional(),
  hooks: z.string().optional(),
  interface: pluginInterfaceSchema,
});

/** Zod schema for a Claude Code plugin manifest (.claude-plugin/plugin.json). */
export const claudePluginManifestSchema = pluginBaseSchema.extend({
  $schema: z.string().optional(),
  displayName: z.string().optional(),
  skills: z.string().optional(),
  commands: z.union([z.string(), z.array(z.string())]).optional(),
  agents: z.string().optional(),
  hooks: z.string().optional(),
  mcpServers: z.string().optional(),
});

/** Codex local plugin source: an object envelope naming a relative path. */
const codexLocalSourceSchema = z.object({
  source: z.literal('local'),
  path: z.string(),
});

/** Claude local plugin source: a relative path string that must start with `./`. */
const claudeLocalSourceSchema = z
  .string()
  .regex(/^\.\//, 'Claude marketplace source must be a relative path starting with "./"');

/**
 * Zod schema for a Claude Code marketplace manifest
 * (`.claude-plugin/marketplace.json`). Claude requires a top-level `owner`
 * object and rejects the Codex-only `interface`/`policy` shapes, so the two
 * providers get distinct schemas.
 */
export const claudeMarketplaceSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Marketplace name must be kebab-case'),
  description: z.string().optional(),
  owner: z.object({ name: z.string(), email: z.string().optional() }),
  plugins: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Plugin name must be kebab-case'),
        source: claudeLocalSourceSchema,
        description: z.string().optional(),
        category: z.string().optional(),
      }),
    )
    .min(1),
});

/**
 * Zod schema for a Codex marketplace manifest
 * (`.agents/plugins/marketplace.json`). Codex uses an `interface` block and a
 * per-plugin `policy` envelope rather than Claude's `owner`.
 */
export const codexMarketplaceSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Marketplace name must be kebab-case'),
  interface: z.object({ displayName: z.string() }),
  plugins: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'Plugin name must be kebab-case'),
        source: codexLocalSourceSchema,
        // Pinned to the literals the emitter produces; observed on every real
        // Codex marketplace. A typo in the emitted policy fails the build.
        policy: z.object({
          installation: z.literal('AVAILABLE'),
          authentication: z.literal('ON_INSTALL'),
        }),
        category: z.string().optional(),
      }),
    )
    .min(1),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type ClaudePluginManifest = z.infer<typeof claudePluginManifestSchema>;
export type ClaudeMarketplace = z.infer<typeof claudeMarketplaceSchema>;
export type CodexMarketplace = z.infer<typeof codexMarketplaceSchema>;
