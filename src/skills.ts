import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import skillBody from './skills/tasks.md';

export type SkillTarget = 'codex' | 'claude' | 'cursor';

type WrittenSkill = {
  target: SkillTarget;
  path: string;
};

const targets: Record<SkillTarget, string> = {
  codex: '.agents/skills/tasks/SKILL.md',
  claude: '.claude/skills/tasks/SKILL.md',
  cursor: '.cursor/rules/tasks.md',
};

export const skillTargets: SkillTarget[] = ['codex', 'claude', 'cursor'];

export const setupSkills = async (
  projectRoot: string,
  target: SkillTarget | '--all',
): Promise<WrittenSkill[]> => {
  const selectedTargets = target === '--all' ? skillTargets : [target];
  const written: WrittenSkill[] = [];

  for (const selectedTarget of selectedTargets) {
    const path = join(projectRoot, targets[selectedTarget]);
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, skillBody);
    written.push({ target: selectedTarget, path });
  }

  return written;
};
