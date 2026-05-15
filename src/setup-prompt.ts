/**
 * Raw text returned by `tasks setup --prompt`. Designed to be piped into an
 * agent so it can run the full Scrumlord installation/refresh sequence
 * without the user having to recall each subcommand.
 */
export const setupAgentPrompt = `You are installing or refreshing the Scrumlord task tooling in this repository.

Run these commands in order from the project root:

1. \`tasks init\` — create the task database if it does not yet exist.
2. \`tasks setup --skills --project\` — write the tasks skill into .claude/skills and .agents/skills.
3. \`tasks setup --subagents --project\` — write the scrumlord-task-manager subagent locally.
4. \`tasks setup --git-hooks\` — install the project lefthook block between the # scrumlord:begin and # scrumlord:end markers.
5. \`tasks setup --agent-hooks --user\` — write user-level Claude and Codex hook configuration to ~/.claude/settings.json and ~/.codex/.

If any of these were already installed in a previous version, re-running the same command refreshes the contents in place — inspect these locations and re-run the corresponding command if anything looks stale:

- .claude/skills/tasks/
- .claude/agents/scrumlord-task-manager.md
- .agents/
- ~/.claude/skills/tasks/
- ~/.claude/agents/scrumlord-task-manager.md
- the # scrumlord:begin / # scrumlord:end block in lefthook.yml
- the Scrumlord hooks block in ~/.claude/settings.json, .claude/settings.json, and .claude/settings.local.json

Do not edit those files by hand — re-run the matching \`tasks setup --<mode>\` command instead. Report back when each command finishes.
`;
