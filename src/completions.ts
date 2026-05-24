/* eslint-disable max-lines */
import {
  flagValueKinds,
  commandSpecifications,
  type PositionalKind,
  type PositionalVariant,
} from './cli-arguments.js';
import { taskStatuses } from './types.js';

/** Static completion candidates for each kind. */
const staticChoices: Partial<Record<PositionalKind, string[]>> = {
  status: [...taskStatuses],
  priority: ['1', '2', '3'],
  shell: ['bash', 'zsh'],
  'tag-action': ['add', 'remove'],
  'blocker-action': ['add', 'remove'],
};

/**
 * Short summaries for each visible command, shown in zsh _describe lists.
 * Must cover every command where visibleInCompletions !== false.
 */
export const commandSummaries: Record<string, string> = {
  available: 'List ready, unblocked tasks.',
  list: 'List tasks for graph reconciliation.',
  blocked: 'List currently blocked tasks.',
  completed: 'List completed tasks.',
  complete: 'Mark tasks completed, or sync-merge ready PRs.',
  init: 'Initialize Scrumlord for the current project.',
  overview: 'Show a task status overview with PR state.',
  help: 'Show help for the CLI or a specific command.',
  current: 'Return the task assigned to the current branch.',
  next: 'Return the next available task.',
  remaining: 'Count remaining tasks.',
  repository: 'Show the current GitHub repository.',
  pr: 'Inspect or sync the current pull request.',
  get: 'Get a task by ID.',
  tagged: 'List tasks with a specific tag.',
  tags: 'Inspect or update tags for a task.',
  blockers: 'Inspect or update blockers for a task.',
  'with-branch': 'List tasks assigned to a specific branch.',
  'blocked-by': 'List tasks blocked by a given task.',
  blocking: 'List tasks that block a given task.',
  priority: 'List tasks at a given priority level.',
  status: 'List tasks at a given status.',
  session: 'Show task agent session metadata.',
  progress: 'Inspect or record task progress.',
  clear: 'Clear a task field.',
  start: 'Start a task and launch an agent.',
  pipeline: 'Run the automated pipeline.',
  'agent-hook': 'Handle an agent lifecycle hook event.',
  delete: 'Delete a task.',
  cleanup: 'Remove old completed tasks or recover orphaned in-progress tasks.',
  search: 'Fuzzy-search tasks by title or description.',
  plan: 'Emit a Markdown prompt directing an agent to author task plans.',
  create: 'Create a new task.',
  update: 'Update a task.',
  setup: 'Configure Scrumlord and agent integrations.',
  teleport: 'Print the worktree path for a task (for shell cd).',
  completions: 'Generate shell completion scripts.',
};

/** Backslash-escapes characters special in bash word lists and double-quoted strings. */
export const escapeBashWordList = (value: string): string =>
  value.replace(/[\s$`"'\\]/g, (ch) => `\\${ch}`);

/** Backslash-escapes characters special in zsh _arguments spec strings. */
export const escapeZshDescription = (value: string): string =>
  value.replace(/[:[\]'$`\\]/g, (ch) => `\\${ch}`);

const visibleCommands = (): string[] => {
  const specs = commandSpecifications;
  return Object.keys(specs)
    .filter((name) => specs[name]?.visibleInCompletions !== false)
    .toSorted();
};

/** Collects the set of kinds at a given 0-based positional index across all variants. */
const kindsAtIndex = (variants: readonly PositionalVariant[], index: number): PositionalKind[] => {
  const seen = new Set<PositionalKind>();
  for (const variant of variants) {
    const kind = variant[index];
    if (kind !== undefined) seen.add(kind);
  }
  return [...seen];
};

/** Returns the max positional count across all variants. */
const maxVariantLength = (variants: readonly PositionalVariant[]): number =>
  Math.max(...variants.map((v) => v.length));

/** Renders bash candidates for a single kind. */
const bashKindCompletion = (kind: PositionalKind): string => {
  const choices = staticChoices[kind];
  if (choices) return `__tasks_reply_from_words ${choices.map(escapeBashWordList).join(' ')}`;
  if (kind === 'task-id') return '__tasks_complete_ids';
  if (kind === 'tag') return '__tasks_complete_tags';
  if (kind === 'file') return `COMPREPLY=( $(compgen -f -- "$cur") )`;
  return `__tasks_reply_from_words`;
};

const renderBashMultiKindCase = (pos: number, kinds: PositionalKind[]): string => {
  const lines: string[] = [`        ${pos})`];
  for (const kind of kinds) {
    if (kind === 'task-id') {
      lines.push(
        `          local _ids_tmp=( "\${COMPREPLY[@]}" ); __tasks_complete_ids; COMPREPLY=( "\${_ids_tmp[@]}" "\${COMPREPLY[@]}" )`,
      );
    } else if (kind === 'tag') {
      lines.push(
        `          local _tags_tmp=( "\${COMPREPLY[@]}" ); __tasks_complete_tags; COMPREPLY=( "\${_tags_tmp[@]}" "\${COMPREPLY[@]}" )`,
      );
    } else if (staticChoices[kind]) {
      lines.push(
        `          local _static_tmp=( "\${COMPREPLY[@]}" ); ${bashKindCompletion(kind)}; COMPREPLY=( "\${_static_tmp[@]}" "\${COMPREPLY[@]}" )`,
      );
    }
  }
  lines.push(`          ;;`);
  return lines.join('\n');
};

/**
 * Renders the bash per-command positional branch for one command.
 * Returns an empty string when the command has no positionalVariants.
 */
export const renderBashPositionalBranch = (commandName: string): string => {
  const spec = commandSpecifications[commandName];
  if (!spec?.positionalVariants?.length) return '';
  const variants = spec.positionalVariants;
  const max = maxVariantLength(variants);
  if (max === 0) return '';

  const valueFlags = spec.valueFlags ?? [];
  const valueFlagArgs = valueFlags.map((f) => `"${f}"`).join(' ');
  const posIndexCall = `local p; p=$(__tasks_positional_index "${commandName}"${valueFlagArgs ? ` ${valueFlagArgs}` : ''})`;

  const cases: string[] = [];
  for (let i = 0; i < max; i++) {
    const kinds = kindsAtIndex(variants, i);
    if (kinds.length === 0) continue;
    const pos = i + 1;

    if (kinds.length === 1) {
      cases.push(`        ${pos}) ${bashKindCompletion(kinds[0]!)} ;;`);
    } else {
      cases.push(renderBashMultiKindCase(pos, kinds));
    }
  }

  return [
    `      ${posIndexCall}`,
    `      case "$p" in`,
    ...cases,
    `      esac`,
    `      return ;;`,
  ].join('\n');
};

/** Renders a single zsh _arguments spec line for a command (for direct unit testing). */
export const renderZshArgumentsLine = (commandName: string, index: number): string => {
  const spec = commandSpecifications[commandName];
  if (!spec?.positionalVariants?.length) return '';
  const variants = spec.positionalVariants;
  const kinds = kindsAtIndex(variants, index);
  if (kinds.length === 0) return '';
  return renderZshPositionalSpec(index + 1, kinds);
};

/** Renders a zsh _alternative spec for multiple kinds at one position. */
export const renderZshAlternative = (kinds: PositionalKind[]): string => {
  const parts = kinds.map((kind) => {
    const choices = staticChoices[kind];
    if (choices) return `"${kind}:${kind}:(${choices.join(' ')})"`;
    if (kind === 'task-id') return `"task-id:task id:__tasks_ids"`;
    if (kind === 'tag') return `"tag:tag:__tasks_tags"`;
    if (kind === 'file') return `"file:file:_files"`;
    return `"${kind}:${kind}:()"`;
  });
  return `_alternative ${parts.join(' ')}`;
};

const renderZshPositionalSpec = (pos: number, kinds: PositionalKind[]): string => {
  if (kinds.length === 1) {
    const kind = kinds[0]!;
    const choices = staticChoices[kind];
    if (choices) return `'${pos}:${kind}:(${choices.join(' ')})'`;
    if (kind === 'task-id') return `'${pos}:task id:__tasks_ids'`;
    if (kind === 'tag') return `'${pos}:tag:__tasks_tags'`;
    if (kind === 'file') return `'${pos}:file:_files'`;
    return `'${pos}:${kind}:()'`;
  }
  return `'${pos}: :->pos${pos}'`;
};

const renderZshValueFlagSpec = (f: string): string => {
  const kind = flagValueKinds[f];
  const choices = kind ? staticChoices[kind] : undefined;
  if (f === 'plan') return `'--${f}=[${f}]:path:_files'`;
  if (choices) return `'--${f}=[${f}]:value:(${choices.join(' ')})'`;
  return `'--${f}=[${f}]:value:'`;
};

const renderZshPositionalArgs = (
  variants: readonly PositionalVariant[],
  argParts: string[],
): void => {
  const max = maxVariantLength(variants);
  for (let i = 0; i < max; i++) {
    const kinds = kindsAtIndex(variants, i);
    if (kinds.length === 0) continue;
    if (kinds.length > 1) {
      argParts.push(`'${i + 1}: :->pos${i + 1}'`);
    } else {
      argParts.push(renderZshPositionalSpec(i + 1, kinds));
    }
  }
};

const renderZshCommandArgs = (commandName: string): string => {
  const spec = commandSpecifications[commandName];
  if (!spec) return '';

  const argParts: string[] = ['--help[Show help.]'];

  for (const f of [...(spec.booleanFlags ?? [])].toSorted()) {
    argParts.push(`'--${f}[${f}.]'`);
  }
  for (const f of [...(spec.valueFlags ?? [])].toSorted()) {
    argParts.push(renderZshValueFlagSpec(f));
  }

  if (spec.positionalVariants?.length) {
    renderZshPositionalArgs(spec.positionalVariants, argParts);
  }

  return `_arguments ${argParts.join(' \\\n          ')}`;
};

const renderZshAlternativeCases = (commandName: string): string[] => {
  const spec = commandSpecifications[commandName];
  if (!spec?.positionalVariants?.length) return [];
  const variants = spec.positionalVariants;
  const max = maxVariantLength(variants);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    const kinds = kindsAtIndex(variants, i);
    if (kinds.length <= 1) continue;
    lines.push(`          pos${i + 1})`);
    lines.push(`            ${renderZshAlternative(kinds)} ;;`);
  }
  return lines;
};

/** Returns the set of command names embedded in the bash discovery list region. */
export const extractCommandListRegion = (script: string, shell: 'bash' | 'zsh'): string[] => {
  if (shell === 'bash') {
    const match = script.match(/__tasks_reply_from_words\s+((?:[^\n]+\\\n)*[^\n]+)/m);
    if (!match) return [];
    return (match[1] ?? '').trim().split(/\s+/).filter(Boolean);
  }
  // Match the _tasks_commands array body between _tasks_commands=( and the closing )
  const match = script.match(/_tasks_commands=\(\n([\s\S]*?)\n\s*\)/);
  if (!match) return [];
  return (match[1] ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^"([^:]+):.*"$/, '$1'))
    .filter(Boolean);
};

/** Returns the computed default install path for a shell. Throws `no_install_path` if HOME is unset. */
export const defaultInstallPath = (
  shell: 'bash' | 'zsh',
  env: Record<string, string | undefined> = process.env,
): string => {
  const home = env['HOME'];
  const xdg = env['XDG_DATA_HOME'] ?? (home ? `${home}/.local/share` : undefined);

  if (shell === 'bash') {
    const bashDir = env['BASH_COMPLETION_USER_DIR'] ?? (xdg ? `${xdg}/bash-completion` : undefined);
    if (!bashDir) {
      throw new Error('no_install_path');
    }
    return `${bashDir}/completions/tasks`;
  }

  if (!xdg) {
    throw new Error('no_install_path');
  }
  return `${xdg}/zsh/site-functions/_tasks`;
};

const bashHeader = `#!/usr/bin/env bash
# Auto-generated by \`tasks completions bash\` — do not edit.

# Populate COMPREPLY from stdin line by line (bash 3.2 compatible).
__tasks_reply_from_stream() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    [[ "$candidate" == "$cur"* ]] && COMPREPLY+=( "$candidate" )
  done
}
__tasks_reply_from_words() {
  local candidate
  COMPREPLY=()
  for candidate in "$@"; do
    [[ "$candidate" == "$cur"* ]] && COMPREPLY+=( "$candidate" )
  done
}
__tasks_complete_ids()  { __tasks_reply_from_stream < <(tasks completions-data ids  2>/dev/null); }
__tasks_complete_tags() { __tasks_reply_from_stream < <(tasks completions-data tags 2>/dev/null); }

# Returns the 1-based positional index of the cursor among non-flag tokens after the subcommand.
__tasks_positional_index() {
  local cmd="$1"; shift
  local -a value_flags=( "$@" )
  local idx=0 skip_next=0 i f
  for ((i=2; i<cword; i++)); do
    local w="\${words[i]}"
    if (( skip_next )); then skip_next=0; continue; fi
    if [[ "$w" == --* ]]; then
      for f in "\${value_flags[@]}"; do
        if [[ "$w" == "--$f" ]]; then skip_next=1; break; fi
      done
      continue
    fi
    idx=$((idx + 1))
  done
  printf '%d' "$((idx + 1))"
}`;

const bashFunctionOpen = `
_tasks() {
  local cur prev words cword
  if declare -F _init_completion >/dev/null 2>&1; then
    _init_completion || return
  else
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  fi

  local cmd="" i
  for ((i=1; i<cword; i++)); do
    case "\${words[i]}" in --*) ;; *) cmd="\${words[i]}"; break ;; esac
  done`;

/** Generates the bash completion script. */
export const generateBashCompletions = (): string => {
  const visible = visibleCommands();
  const specs = commandSpecifications;

  const noSubcmdBranch = `  if [[ -z "$cmd" ]]; then
    __tasks_reply_from_words ${visible.map(escapeBashWordList).join(' ')}
    return
  fi`;

  const flagValueLines: string[] = [];
  const flagKindEntries = Object.entries(flagValueKinds);
  if (flagKindEntries.length) {
    flagValueLines.push(`  # Shared flag-value completion`);
    flagValueLines.push(`  case "$prev" in`);
    for (const [flag, kind] of flagKindEntries.toSorted(([a], [b]) => a.localeCompare(b))) {
      const choices = staticChoices[kind];
      if (choices) {
        flagValueLines.push(
          `    --${flag}) __tasks_reply_from_words ${choices.map(escapeBashWordList).join(' ')}; return ;;`,
        );
      } else if (kind === 'file') {
        flagValueLines.push(`    --${flag}) COMPREPLY=( $(compgen -f -- "$cur") ); return ;;`);
      }
    }
    flagValueLines.push(`  esac`);
    flagValueLines.push(``);
  }

  const perCommandCases: string[] = [];
  perCommandCases.push(`  case "$cmd" in`);
  for (const name of visible.toSorted()) {
    const spec = specs[name];
    if (!spec?.positionalVariants?.length) continue;
    const branch = renderBashPositionalBranch(name);
    if (!branch) continue;
    perCommandCases.push(`    ${name})`);
    perCommandCases.push(branch);
    perCommandCases.push(``);
  }
  perCommandCases.push(`  esac`);
  perCommandCases.push(`}`);
  perCommandCases.push(`complete -F _tasks tasks`);

  return [
    bashHeader,
    bashFunctionOpen,
    ``,
    noSubcmdBranch,
    ``,
    ...flagValueLines,
    ...perCommandCases,
    ``,
  ].join('\n');
};

const zshDollar = '$';
const zshHeader = `#compdef tasks
# Auto-generated by \`tasks completions zsh\` — do not edit.

__tasks_ids()  { local -a ids;  ids=(${zshDollar}{(f)"${zshDollar}(tasks completions-data ids  2>/dev/null)"});  _describe 'task id' ids }
__tasks_tags() { local -a tags; tags=(${zshDollar}{(f)"${zshDollar}(tasks completions-data tags 2>/dev/null)"}); _describe 'tag' tags }`;

/** Generates the zsh completion script. */
export const generateZshCompletions = (): string => {
  const visible = visibleCommands();

  const commandDescEntries = visible
    .map((name) => {
      const summary = commandSummaries[name] ?? '';
      return `  "${name}:${escapeZshDescription(summary)}"`;
    })
    .join('\n');

  const perCommandCases: string[] = [];
  for (const name of visible.toSorted()) {
    const argLine = renderZshCommandArgs(name);
    const altCases = renderZshAlternativeCases(name);

    perCommandCases.push(`        ${name})`);
    if (altCases.length) {
      perCommandCases.push(`          ${argLine}`);
      perCommandCases.push(`          case $state in`);
      perCommandCases.push(...altCases);
      perCommandCases.push(`          esac ;;`);
    } else {
      perCommandCases.push(`          ${argLine} ;;`);
    }
  }

  return [
    zshHeader,
    ``,
    `_tasks_completions_handler() {`,
    `  local context state state_descr line`,
    `  typeset -A opt_args`,
    `  _arguments -C '1: :->command' '*:: :->args'`,
    `  case $state in`,
    `    command)`,
    `      local -a _tasks_commands`,
    `      _tasks_commands=(`,
    commandDescEntries,
    `      )`,
    `      _describe 'command' _tasks_commands ;;`,
    `    args)`,
    `      case $line[1] in`,
    ...perCommandCases,
    `      esac ;;`,
    `  esac`,
    `}`,
    `_tasks_completions_handler "$@"`,
    ``,
  ].join('\n');
};
