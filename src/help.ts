/**
 * `/help` — every chat command NanoClaw intercepts before the agent sees it.
 *
 * Keep this in step with the onMessage dispatch in index.ts (and the channel
 * built-ins in channels/matrix.ts) when adding or renaming a command.
 */

export interface HelpEntry {
  usage: string;
  description: string;
  ownerOnly?: boolean;
}

export interface HelpSection {
  title: string;
  entries: HelpEntry[];
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    title: '🧭 Session',
    entries: [
      { usage: '/info', description: 'Status of the running agent' },
      { usage: '/stop', description: 'Cancel the running agent' },
      {
        usage: '/new',
        description: 'Reset the conversation (asks to confirm)',
      },
      {
        usage: 'nosleep / yessleep',
        description: 'Lift / restore the agent’s runtime cap',
      },
      { usage: '/ping', description: 'Check the bot is online' },
      { usage: '/chatid', description: 'Show this chat’s ID' },
      {
        usage: '/setup-project <name>',
        description:
          'New project: room, folder ~/Documents/koko/<name> mounted, optional GitHub repo',
        ownerOnly: true,
      },
    ],
  },
  {
    title: '🧠 Model, account & tools',
    entries: [
      { usage: '/models', description: 'List selectable models' },
      {
        usage: '/model [n|name]',
        description: 'Show or switch the model',
        ownerOnly: true,
      },
      { usage: '/org', description: 'Which Anthropic account this chat uses' },
      {
        usage: '/agents',
        description: 'Dev-team roles the agent can spawn',
      },
      {
        usage: '/tools',
        description: 'Optional tools (Notion, Design…) and whether they’re on',
      },
      {
        usage: '/tools <name> on|off',
        description: 'Switch a tool for this chat',
        ownerOnly: true,
      },
      {
        usage: '/switch <org>',
        description: 'Switch Anthropic account',
        ownerOnly: true,
      },
    ],
  },
  {
    title: '🌿 Git',
    entries: [
      {
        usage: '/git-info',
        description: 'Branch on your machine vs the agent, plus worktrees',
      },
      {
        usage: '/git-safety [on|off]',
        description: 'Keep the agent on your checked-out branch (default on)',
        ownerOnly: true,
      },
    ],
  },
  {
    title: '🗄️ Prisma',
    entries: [
      {
        usage: '/prisma-db-generate',
        description:
          'Regenerate this chat’s Prisma clients on your Mac now (also runs automatically when the agent changes a schema)',
      },
    ],
  },
  {
    title: '📌 Memory & context',
    entries: [
      {
        usage: '/pin <text> or 📌 <text>',
        description: 'Pin a standing instruction',
      },
      { usage: '/pins', description: 'List pins' },
      { usage: '/unpin <n>', description: 'Remove pin n' },
      { usage: '/consumables', description: 'List reference docs (main chat)' },
      {
        usage: '/consume <name>',
        description: 'Load a reference doc (main chat)',
      },
      {
        usage: '/consumed',
        description: 'Docs loaded this session (main chat)',
      },
    ],
  },
  {
    title: '🖥️ Host access',
    entries: [
      {
        usage: '/godmode [on|off]',
        description: 'Terminal access on the Mac (main chat)',
        ownerOnly: true,
      },
      {
        usage: '/simulator [on|off]',
        description: 'Drive the iOS Simulator / Android Emulator',
        ownerOnly: true,
      },
      {
        usage: '/docker-restart',
        description: 'Force-restart Docker',
        ownerOnly: true,
      },
      {
        usage: '/remote-control',
        description:
          'Start a remote-control session, end with /remote-control-end (main chat)',
      },
    ],
  },
  {
    title: 'ℹ️ Help',
    entries: [{ usage: '/help', description: 'This list' }],
  },
];

export function formatHelp(): string {
  const lines = ['🤖 Commands', ''];
  for (const section of HELP_SECTIONS) {
    lines.push(section.title);
    for (const e of section.entries) {
      lines.push(`• ${e.usage} — ${e.description}${e.ownerOnly ? ' 🔒' : ''}`);
    }
    lines.push('');
  }
  lines.push(
    '🔒 = owner only. /gitinfo, /gitsafety and /prisma_db_generate work too. Anything else goes to the agent.',
  );
  return lines.join('\n');
}
