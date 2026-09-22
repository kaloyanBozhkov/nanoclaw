import { describe, it, expect, beforeEach } from 'vitest';

import {
  approxTokens,
  formatConsumablesMenu,
  getConsumed,
  importedSlugs,
  listConsumables,
  readConsumable,
  recordConsumed,
  resolveConsumable,
  wrapConsumable,
} from '../src/consumables.js';
import { _initTestDatabase } from '../src/db.js';

beforeEach(() => {
  _initTestDatabase();
});

const bible = () => {
  const c = resolveConsumable('bible');
  if (!c) throw new Error('bible consumable missing');
  return c;
};

describe('registry', () => {
  it('discovers the repo docs by scanning, not a hardcoded list', () => {
    const slugs = listConsumables().map((c) => c.slug);
    expect(slugs).toContain('bible');
    expect(slugs).toContain('agents');
  });

  it('gives each consumable a unique slug', () => {
    const slugs = listConsumables().map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('reports a real byte size', () => {
    expect(bible().bytes).toBeGreaterThan(0);
  });
});

describe('resolveConsumable', () => {
  it('matches an exact slug', () => {
    expect(resolveConsumable('bible')?.slug).toBe('bible');
  });

  it('is case-insensitive and trims', () => {
    expect(resolveConsumable('  BIBLE ')?.slug).toBe('bible');
  });

  it('matches an unambiguous prefix', () => {
    expect(resolveConsumable('bib')?.slug).toBe('bible');
  });

  it('matches by filename', () => {
    expect(resolveConsumable('CODE_BIBLE.md')?.slug).toBe('bible');
  });

  it('returns undefined for a miss so the caller shows the menu', () => {
    expect(resolveConsumable('bibel')).toBeUndefined();
    expect(resolveConsumable('')).toBeUndefined();
  });
});

describe('readConsumable', () => {
  it('inlines @import markers instead of leaving the token', () => {
    const agents = resolveConsumable('agents');
    if (!agents) throw new Error('agents consumable missing');

    const resolved = readConsumable(agents);
    // The raw file carries `@CODE_BIBLE.md`; the resolved text must carry the
    // bible's contents in its place — that is how non-main groups see it.
    expect(resolved).not.toMatch(/^@CODE_BIBLE\.md$/m);
    expect(resolved.length).toBeGreaterThan(agents.bytes);
    expect(resolved).toContain(readConsumable(bible()).slice(0, 200));
  });

  it('reports imports for the menu', () => {
    expect(importedSlugs(resolveConsumable('agents')!)).toContain('bible');
    expect(importedSlugs(bible())).toEqual([]);
  });
});

describe('wrapConsumable', () => {
  it('frames the body and suppresses a summary echo', () => {
    const wrapped = wrapConsumable(bible(), 'BODY');
    expect(wrapped).toContain('<consumed-document slug="bible"');
    expect(wrapped).toContain('BODY');
    expect(wrapped).toContain('</consumed-document>');
    expect(wrapped).toMatch(/do not summarize it back/i);
  });
});

describe('consumed state', () => {
  it('starts empty', () => {
    expect(getConsumed('telegram_main', 'sess-1')).toEqual([]);
  });

  it('records and reads back within a session', () => {
    recordConsumed('telegram_main', 'sess-1', bible(), 1234);
    const items = getConsumed('telegram_main', 'sess-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ slug: 'bible', bytes: 1234 });
  });

  it('resets when the session id changes — /new clears it for free', () => {
    recordConsumed('telegram_main', 'sess-1', bible(), 10);
    expect(getConsumed('telegram_main', 'sess-2')).toEqual([]);
  });

  it('keeps groups separate', () => {
    recordConsumed('telegram_main', 'sess-1', bible(), 10);
    expect(getConsumed('telegram_other', 'sess-1')).toEqual([]);
  });

  it('does not duplicate a re-consumed doc', () => {
    recordConsumed('telegram_main', 'sess-1', bible(), 10);
    recordConsumed('telegram_main', 'sess-1', bible(), 20);
    const items = getConsumed('telegram_main', 'sess-1');
    expect(items).toHaveLength(1);
    expect(items[0].bytes).toBe(20);
  });

  it('survives being recorded before any session id exists', () => {
    // Consuming before the first container run has no session id to key on;
    // the entry must carry into the session it was meant for, not vanish.
    recordConsumed('telegram_main', '', bible(), 10);
    expect(getConsumed('telegram_main', 'sess-1')).toHaveLength(1);
  });
});

describe('menu', () => {
  it('marks consumed vs available and offers the action', () => {
    recordConsumed('telegram_main', 'sess-1', bible(), 10);
    const menu = formatConsumablesMenu(
      listConsumables(),
      getConsumed('telegram_main', 'sess-1'),
    );
    expect(menu).toContain('✅ *bible*');
    expect(menu).toContain('○ *agents*');
    expect(menu).toContain('/consume <name>');
    expect(menu).toContain('includes: bible');
  });

  it('shows every entry as available when nothing is consumed', () => {
    const menu = formatConsumablesMenu(listConsumables(), []);
    expect(menu).not.toContain('✅');
    expect(menu).toContain('○ *bible*');
  });

  it('carries a notice for an unmatched name', () => {
    const menu = formatConsumablesMenu(listConsumables(), [], 'No match for *xyz*.');
    expect(menu.startsWith('No match for *xyz*.')).toBe(true);
  });

  it('uses Telegram formatting, never markdown', () => {
    const menu = formatConsumablesMenu(listConsumables(), []);
    expect(menu).not.toMatch(/\*\*/);
    expect(menu).not.toMatch(/^#/m);
  });
});

describe('approxTokens', () => {
  it('summarizes size in tokens', () => {
    expect(approxTokens(400)).toBe('~100');
    expect(approxTokens(76000)).toBe('~19K');
  });
});
