import { z } from 'zod';

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
  skills: z.string().optional(),
  commands: z.union([z.string(), z.array(z.string())]).optional(),
  agents: z.string().optional(),
  hooks: z.string().optional(),
  mcpServers: z.string().optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type ClaudePluginManifest = z.infer<typeof claudePluginManifestSchema>;
