/**
 * Git safety — keeps the agent on the branch the user has checked out.
 *
 * The user's repos are bind-mounted read-write, so the agent and the user
 * share one working tree. Worktrees, branch switches, stashes and hard resets
 * make what the agent did diverge from what the user sees locally (or throw
 * away the user's uncommitted work), so while the group's switch is on
 * (host: src/git-safety.ts, `/git-safety on|off`) they are refused here.
 *
 * Pure functions only: no SDK imports, so tests can load this file directly.
 */

/** Appended to the system prompt while git safety is on. */
export const GIT_SAFETY_RULES = `## Git Safety (ON — enforced)

The user's repos under /workspace/extra/ are their real local checkouts, shared live with their editor and dev server. Everything you do there is exactly what they see locally — keep it that way.

- Work directly in the mounted repo (e.g. /workspace/extra/<repo>). Never create git worktrees or copies of the repo.
- You may switch and create branches in place (\`git switch\`, \`git switch -c\`, \`git checkout <branch>\`, \`git checkout -b\`) when the task calls for it. Each time, say in chat which branch you moved from and to — their editor and dev server move with you. Git itself refuses a switch that would overwrite uncommitted changes; if it does, stop and ask the user rather than forcing it.
- Never hide or discard the user's uncommitted work: no \`git stash\`, \`git reset --hard\`, \`git clean -f\`, \`git checkout -- .\`, \`git restore .\`, and no \`--force\`/\`-f\`/\`--discard-changes\` on switch or checkout.
- Never rewrite or delete history/branches: no \`git rebase\`, \`git push --force\`, \`git branch -D\`, \`git checkout -B\`/\`git switch -C\` on an existing branch.
- Before starting, run \`git status\` and \`git branch --show-current\` and state the branch you're working on.
- Ask before committing directly to main/master. Push only when asked.

The blocked commands are enforced by a hook; the user can lift it with /git-safety off.`;

const LIFT_HINT = 'Ask the user to do it, or to send /git-safety off.';

// Global git options that consume the next token (`git -C dir status`).
const GLOBAL_OPTS_WITH_ARG = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--exec-path',
]);

// Pathspecs that mean "everything", i.e. discard all of the user's changes.
const WHOLE_TREE = new Set(['.', './', ':/', '*', ':(top)']);

/**
 * Split a shell command into simple-command segments and their words.
 * Deliberately loose: quotes are dropped rather than honoured, so a git
 * command hidden inside `sh -c "..."` or `$(...)` is still seen. That can
 * over-match (`echo git switch`), which is the safe direction.
 */
function segments(command: string): string[][] {
  return command
    .replace(/\\\n/g, ' ')
    .split(/&&|\|\||[;|&\n()`]|\$\(/)
    .map((seg) => seg.replace(/["']/g, ' ').split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((a) =>
    flags.some((f) =>
      f.startsWith('--')
        ? a === f || a.startsWith(`${f}=`)
        : // Short flags may be bundled: `-fd`, `-fdx`.
          a === f || (/^-[a-zA-Z]+$/.test(a) && a.includes(f.slice(1))),
    ),
  );
}

/** Reason the git invocation `sub args` is blocked, or null if allowed. */
function checkGit(sub: string, args: string[]): string | null {
  const positional = args.filter((a) => !a.startsWith('-'));
  const dashDash = args.indexOf('--');

  switch (sub) {
    case 'worktree':
      if (positional[0] === 'add' || positional[0] === 'move') {
        return 'git worktree is blocked by git safety: work directly in the mounted repo on the branch the user has checked out, so they see your changes live.';
      }
      return null;

    case 'switch':
      if (hasFlag(args, '-f', '--force', '--discard-changes')) {
        return `Forcing a branch switch is blocked by git safety — it throws away uncommitted work in the user's checkout. Commit or ask the user first. ${LIFT_HINT}`;
      }
      if (hasFlag(args, '-C', '--force-create')) {
        return `\`git switch -C\` resets an existing branch, which git safety blocks. Use \`git switch -c <new-branch>\`. ${LIFT_HINT}`;
      }
      return null;

    case 'checkout': {
      if (hasFlag(args, '-f', '--force')) {
        return `Forced checkout is blocked by git safety — it throws away uncommitted work in the user's checkout. Commit or ask the user first. ${LIFT_HINT}`;
      }
      if (hasFlag(args, '-B')) {
        return `\`git checkout -B\` resets an existing branch, which git safety blocks. Use \`git checkout -b <new-branch>\`. ${LIFT_HINT}`;
      }
      const paths = dashDash !== -1 ? args.slice(dashDash + 1) : positional;
      if (paths.some((p) => WHOLE_TREE.has(p))) {
        return `Discarding every uncommitted change is blocked by git safety — the working tree is shared with the user. Restore specific files you changed instead.`;
      }
      // Branch switches and single-file restores are fine: git refuses a
      // switch that would overwrite local changes on its own.
      return null;
    }

    case 'restore':
      if (
        !hasFlag(args, '--staged', '-S') ||
        hasFlag(args, '--worktree', '-W')
      ) {
        const paths = dashDash !== -1 ? args.slice(dashDash + 1) : positional;
        if (paths.some((p) => WHOLE_TREE.has(p))) {
          return `Discarding every uncommitted change is blocked by git safety — the working tree is shared with the user. Restore specific files you changed instead.`;
        }
      }
      return null;

    case 'stash':
      if (positional[0] === 'list' || positional[0] === 'show') return null;
      return `git stash is blocked by git safety — it would hide the user's uncommitted work. ${LIFT_HINT}`;

    case 'reset':
      if (hasFlag(args, '--hard', '--keep', '--merge')) {
        return `git reset --hard is blocked by git safety — it would discard the user's uncommitted work. ${LIFT_HINT}`;
      }
      return null;

    case 'clean':
      if (hasFlag(args, '-n', '--dry-run')) return null;
      if (hasFlag(args, '-f', '--force')) {
        return `git clean is blocked by git safety — it would delete the user's untracked files. Use \`git clean -n\` to list them. ${LIFT_HINT}`;
      }
      return null;

    case 'rebase':
      return `git rebase is blocked by git safety — it rewrites the user's checked-out branch. ${LIFT_HINT}`;

    case 'push':
      if (hasFlag(args, '-f', '--force', '--force-with-lease', '--mirror')) {
        return `Force-pushing is blocked by git safety. ${LIFT_HINT}`;
      }
      if (positional.some((p) => p.startsWith('+'))) {
        return `Force-pushing (+refspec) is blocked by git safety. ${LIFT_HINT}`;
      }
      return null;

    case 'branch':
      if (
        hasFlag(
          args,
          '-d',
          '-D',
          '--delete',
          '-m',
          '-M',
          '--move',
          '-f',
          '--force',
        )
      ) {
        return `Deleting, renaming or force-moving branches is blocked by git safety. ${LIFT_HINT}`;
      }
      return null;

    default:
      return null;
  }
}

/** Reason a shell command is blocked by git safety, or null if allowed. */
export function checkGitCommand(command: string): string | null {
  for (const words of segments(command)) {
    for (let i = 0; i < words.length; i++) {
      if (words[i] !== 'git' && !words[i].endsWith('/git')) continue;
      let j = i + 1;
      while (j < words.length && words[j].startsWith('-')) {
        if (GLOBAL_OPTS_WITH_ARG.has(words[j])) j++;
        j++;
      }
      if (j < words.length) {
        const reason = checkGit(words[j], words.slice(j + 1));
        if (reason) return reason;
      }
      // Only the first git per segment is a command; later ones are
      // arguments to it (`git commit -m "fix git switch bug"`).
      break;
    }
  }
  return null;
}

/** Tools the git-safety hook needs to see. */
export const GIT_SAFETY_TOOL_MATCHER = 'Bash|EnterWorktree|Agent|Task';

/** Reason a tool call is blocked by git safety, or null if allowed. */
export function checkGitSafetyToolUse(
  toolName: string,
  toolInput: unknown,
): string | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (toolName === 'Bash') {
    return typeof input.command === 'string'
      ? checkGitCommand(input.command)
      : null;
  }
  if (toolName === 'EnterWorktree') {
    return 'Worktrees are blocked by git safety: work directly in the mounted repo on the branch the user has checked out.';
  }
  if (
    (toolName === 'Agent' || toolName === 'Task') &&
    input.isolation === 'worktree'
  ) {
    return 'Sub-agents in worktree isolation are blocked by git safety: launch the agent without `isolation: "worktree"` so it works in the shared checkout.';
  }
  return null;
}
