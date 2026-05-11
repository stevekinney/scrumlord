import { createTaskStore } from './database.js';
import { setupGitHooks, type SetupGitHooksResult } from './git-hooks.js';
import { setupSkills, type SkillTarget } from './skills.js';

export type InitializeProjectOptions = {
  cwd?: string;
  skills?: SkillTarget | '--all' | false;
  gitHooks?: boolean;
};

export type InitializeProjectResult = {
  projectRoot: string;
  databasePath: string;
  skills: Awaited<ReturnType<typeof setupSkills>>;
  gitHooks: SetupGitHooksResult | null;
};

const initializeSkills = async (
  projectRoot: string,
  target: InitializeProjectOptions['skills'],
): Promise<InitializeProjectResult['skills']> => {
  return target === false ? [] : await setupSkills(projectRoot, target ?? '--all');
};

const initializeGitHooks = async (
  projectRoot: string,
  enabled: InitializeProjectOptions['gitHooks'],
): Promise<SetupGitHooksResult | null> => {
  return enabled === false ? null : await setupGitHooks(projectRoot);
};

/** Initializes the project-local Scrumlord database and first-run boilerplate. */
export const initializeProject = async (
  options: InitializeProjectOptions = {},
): Promise<InitializeProjectResult> => {
  const store = await createTaskStore(options.cwd === undefined ? {} : { cwd: options.cwd });

  try {
    const [skills, gitHooks] = await Promise.all([
      initializeSkills(store.projectRoot, options.skills),
      initializeGitHooks(store.projectRoot, options.gitHooks),
    ]);

    return {
      projectRoot: store.projectRoot,
      databasePath: store.databasePath,
      skills,
      gitHooks,
    };
  } finally {
    store.close();
  }
};
