import { $ } from 'bun';

const requiredPackedFiles = [
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.claude-plugin/.mcp.json',
  '.claude-plugin/skills/tasks/SKILL.md',
  '.codex-plugin/.agents/plugins/marketplace.json',
  '.codex-plugin/plugins/scrumlord/.codex-plugin/plugin.json',
  '.codex-plugin/plugins/scrumlord/.mcp.json',
  '.codex-plugin/plugins/scrumlord/skills/tasks/SKILL.md',
  '.codex-plugin/plugins/scrumlord/skills/scrumlord-task-manager/SKILL.md',
];

const pack = await $`npm pack --dry-run --json --ignore-scripts`.quiet();
const parsed = JSON.parse(pack.stdout.toString()) as Array<{
  files?: Array<{ path?: string }>;
}>;
const packedFilePaths =
  parsed[0]?.files?.map((file) => file.path).filter((path): path is string => path !== undefined) ??
  [];
const packedFiles = new Set(packedFilePaths);
const missing = requiredPackedFiles.filter((path) => !packedFiles.has(path));

if (missing.length > 0) {
  process.stderr.write(
    `Packed package is missing plugin artifacts:\n${missing.map((path) => `- ${path}`).join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write('Packed package includes Claude and Codex plugin artifacts.\n');
