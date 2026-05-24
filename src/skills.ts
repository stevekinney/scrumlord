import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import skillBody from './skills/tasks.md';

export type SkillTarget = 'codex' | 'claude';

export type WrittenSkill = {
  target: SkillTarget;
  path: string;
};

const targets: Record<SkillTarget, string> = {
  codex: '.agents/skills/tasks/SKILL.md',
  claude: '.claude/skills/tasks/SKILL.md',
};

export const skillTargets: SkillTarget[] = ['codex', 'claude'];

const skillFrontmatter = `---
name: tasks
description: Use this skill when inspecting, updating, or synchronizing the local tasks CLI graph for this project, including task lifecycle, planning metadata, pull request readiness, and Scrumlord setup.
---

`;

const buildSkillDocument = (): string => {
  if (skillBody.startsWith('---\n')) return skillBody;
  return `${skillFrontmatter}${skillBody}`;
};

export const setupSkills = async (
  projectRoot: string,
  target: SkillTarget | '--all',
): Promise<WrittenSkill[]> => {
  const selectedTargets = target === '--all' ? skillTargets : [target];
  const written: WrittenSkill[] = [];
  const skillDocument = buildSkillDocument();

  for (const selectedTarget of selectedTargets) {
    const path = join(projectRoot, targets[selectedTarget]);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, skillDocument);
    written.push({ target: selectedTarget, path });
  }

  return written;
};
