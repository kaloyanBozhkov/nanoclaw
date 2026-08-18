import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string>,
}));

vi.mock('../src/env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) =>
    Object.fromEntries(
      Object.entries(mockEnv).filter(([k]) => keys.includes(k)),
    ),
  ),
  readEnvPrefixed: vi.fn((prefix: string) =>
    Object.fromEntries(
      Object.entries(mockEnv).filter(([k]) => k.startsWith(prefix)),
    ),
  ),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const {
  listOrgs,
  resolveOrg,
  resolveGroupOrg,
  orgPlaceholder,
  parseOrgPlaceholder,
} = await import('../src/config.js');

function setEnv(entries: Record<string, string>): void {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k];
  Object.assign(mockEnv, entries);
}

beforeEach(() => setEnv({}));
afterEach(() => setEnv({}));

describe('listOrgs', () => {
  it('finds nothing when no credential is configured', () => {
    expect(listOrgs()).toEqual([]);
  });

  it('registers a legacy single credential as the default org', () => {
    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' });
    expect(listOrgs()).toEqual([
      { name: 'default', authMode: 'oauth', envKey: 'CLAUDE_CODE_OAUTH_TOKEN' },
    ]);
  });

  it('derives the auth mode from the variable suffix', () => {
    setEnv({
      ANTHROPIC_ORG_WORK_OAUTH_TOKEN: 'sk-ant-oat01-w',
      ANTHROPIC_ORG_SIDE_API_KEY: 'sk-ant-api03-s',
    });
    expect(listOrgs()).toEqual([
      {
        name: 'side',
        authMode: 'api-key',
        envKey: 'ANTHROPIC_ORG_SIDE_API_KEY',
      },
      {
        name: 'work',
        authMode: 'oauth',
        envKey: 'ANTHROPIC_ORG_WORK_OAUTH_TOKEN',
      },
    ]);
  });

  it('keeps the legacy credential alongside named orgs', () => {
    setEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-p',
      ANTHROPIC_ORG_WORK_OAUTH_TOKEN: 'sk-ant-oat01-w',
    });
    expect(listOrgs().map((o) => o.name)).toEqual(['default', 'work']);
  });

  it('ignores an ANTHROPIC_ORG_ key with no recognised suffix', () => {
    setEnv({ ANTHROPIC_ORG_WORK_REGION: 'us' });
    expect(listOrgs()).toEqual([]);
  });

  // Both suffixes for one identity is a config mistake. Choosing the API key
  // would silently drop Claude Design access the user had configured.
  it('prefers OAuth when an org defines both credential kinds', () => {
    setEnv({
      ANTHROPIC_ORG_EH_WORK_OAUTH_TOKEN: 'sk-ant-oat01-w',
      ANTHROPIC_ORG_EH_WORK_API_KEY: 'sk-ant-api03-w',
    });
    expect(listOrgs()).toEqual([
      {
        name: 'eh_work',
        authMode: 'oauth',
        envKey: 'ANTHROPIC_ORG_EH_WORK_OAUTH_TOKEN',
      },
    ]);
  });

  it('keeps underscores in a multi-word org name', () => {
    setEnv({ ANTHROPIC_ORG_EH_WORK_OAUTH_TOKEN: 'x' });
    expect(listOrgs()[0].name).toBe('eh_work');
  });

  it('prefers an API key over an OAuth token for the legacy default', () => {
    setEnv({
      ANTHROPIC_API_KEY: 'sk-ant-api03-x',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
    });
    expect(listOrgs()[0]).toMatchObject({
      name: 'default',
      authMode: 'api-key',
    });
  });
});

describe('resolveGroupOrg', () => {
  beforeEach(() =>
    setEnv({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-p',
      ANTHROPIC_ORG_WORK_OAUTH_TOKEN: 'sk-ant-oat01-w',
    }),
  );

  it('uses the default when a chat has never switched', () => {
    expect(resolveGroupOrg(undefined)?.name).toBe('default');
  });

  it('honours a configured org, case-insensitively', () => {
    expect(resolveGroupOrg('work')?.name).toBe('work');
    expect(resolveGroupOrg('WORK')?.name).toBe('work');
  });

  // The whole point of the feature: a chat pinned to an identity that has
  // disappeared must NOT quietly run on a different account.
  it('returns null rather than falling back when the configured org is gone', () => {
    setEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-p' }); // work removed
    expect(resolveGroupOrg('work')).toBeNull();
    expect(resolveGroupOrg(undefined)?.name).toBe('default');
  });
});

describe('resolveOrg', () => {
  beforeEach(() => setEnv({ ANTHROPIC_ORG_WORK_OAUTH_TOKEN: 'x' }));

  it('matches a known org', () => {
    expect(resolveOrg('work')?.name).toBe('work');
  });

  it.each(['', '  ', 'nope', 'wor'])('rejects %o', (arg) => {
    expect(resolveOrg(arg)).toBeNull();
  });
});

describe('placeholder routing key', () => {
  it('round-trips an org name', () => {
    expect(parseOrgPlaceholder(orgPlaceholder('work'))).toBe('work');
  });

  it('accepts the Bearer form and lowercases', () => {
    expect(parseOrgPlaceholder('Bearer nanoclaw:Work')).toBe('work');
  });

  it.each([
    ['sk-ant-oat01-real-token', 'a real OAuth token'],
    ['sk-ant-api03-real-key', 'a real API key'],
    ['placeholder', 'the legacy placeholder'],
    ['', 'an empty header'],
    ['nanoclaw:', 'a placeholder with no org'],
  ])('does not claim %o (%s)', (value) => {
    expect(parseOrgPlaceholder(value)).toBeNull();
  });
});
