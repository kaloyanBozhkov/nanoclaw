import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  extractFromBlob,
  getDesignCredential,
  getFreshDesignCredential,
  isDesignRequest,
  needsRefresh,
  _resetDesignCredentialCache,
} from '../src/design-credential.js';

beforeEach(() => {
  _resetDesignCredentialCache();
  delete process.env.CLAUDE_CODE_DESIGN_OAUTH_TOKEN;
});

afterEach(() => {
  _resetDesignCredentialCache();
  delete process.env.CLAUDE_CODE_DESIGN_OAUTH_TOKEN;
});

describe('isDesignRequest', () => {
  it('matches the design MCP endpoint', () => {
    expect(isDesignRequest('/v1/design/mcp')).toBe(true);
    expect(isDesignRequest('/v1/design/anything')).toBe(true);
  });

  it('leaves every other API route to the org routing key', () => {
    expect(isDesignRequest('/v1/messages')).toBe(false);
    expect(isDesignRequest('/v1/models')).toBe(false);
    // Guard against a prefix that merely contains the word.
    expect(isDesignRequest('/v1/designs')).toBe(false);
    expect(isDesignRequest('/design/mcp')).toBe(false);
    expect(isDesignRequest(undefined)).toBe(false);
  });
});

describe('getDesignCredential', () => {
  it('prefers the env override over the keychain', () => {
    process.env.CLAUDE_CODE_DESIGN_OAUTH_TOKEN = 'sk-test-design';
    const cred = getDesignCredential();
    expect(cred).toMatchObject({
      accessToken: 'sk-test-design',
      source: 'env',
    });
  });

  it('trims whitespace from the env override', () => {
    process.env.CLAUDE_CODE_DESIGN_OAUTH_TOKEN = '  sk-test-design  ';
    expect(getDesignCredential()?.accessToken).toBe('sk-test-design');
  });

  it('ignores an empty env override rather than sending a blank bearer', () => {
    process.env.CLAUDE_CODE_DESIGN_OAUTH_TOKEN = '   ';
    const cred = getDesignCredential();
    // Falls through to the keychain, which may or may not have one — the point
    // is that a blank string never becomes an Authorization header.
    expect(cred?.accessToken).not.toBe('');
  });

  it('caches so a burst of design calls does not hit the keychain each time', () => {
    process.env.CLAUDE_CODE_DESIGN_OAUTH_TOKEN = 'sk-first';
    expect(getDesignCredential()?.accessToken).toBe('sk-first');
    process.env.CLAUDE_CODE_DESIGN_OAUTH_TOKEN = 'sk-second';
    expect(getDesignCredential()?.accessToken).toBe('sk-first');
    _resetDesignCredentialCache();
    expect(getDesignCredential()?.accessToken).toBe('sk-second');
  });
});

const BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'main',
    refreshToken: 'main-rt',
    scopes: ['user:inference'],
  },
  designOauth: {
    accessToken: 'design-at',
    refreshToken: 'design-rt',
    expiresAt: 1_000_000,
    scopes: ['user:design:read', 'user:design:write'],
    clientId: 'client-1',
  },
});

describe('extractFromBlob', () => {
  it('picks the design entry and keeps what a refresh needs', () => {
    expect(extractFromBlob(BLOB)).toMatchObject({
      accessToken: 'design-at',
      refreshToken: 'design-rt',
      clientId: 'client-1',
      blobKey: 'designOauth',
      expiresAt: 1_000_000,
      source: 'keychain',
    });
  });

  it('returns null for junk or a blob without design scopes', () => {
    expect(extractFromBlob('not json')).toBeNull();
    expect(
      extractFromBlob(JSON.stringify({ claudeAiOauth: { accessToken: 'x' } })),
    ).toBeNull();
  });
});

describe('needsRefresh', () => {
  const cred = extractFromBlob(BLOB)!;

  it('refreshes inside the margin before expiry, not well before it', () => {
    expect(needsRefresh(cred, 1_000_000 - 60_000)).toBe(true);
    expect(needsRefresh(cred, 1_000_000 + 1)).toBe(true);
    expect(needsRefresh(cred, 1_000_000 - 60 * 60_000)).toBe(false);
  });

  it('never refreshes without a refresh token or client id', () => {
    expect(needsRefresh({ ...cred, refreshToken: undefined }, 2e6)).toBe(false);
    expect(needsRefresh({ ...cred, clientId: undefined }, 2e6)).toBe(false);
  });

  it('never refreshes an env override', () => {
    expect(
      needsRefresh({ accessToken: 'x', expiresAt: 0, source: 'env' }, 2e6),
    ).toBe(false);
  });
});

describe('getFreshDesignCredential', () => {
  it('passes an env override straight through', async () => {
    process.env.CLAUDE_CODE_DESIGN_OAUTH_TOKEN = 'sk-env';
    expect((await getFreshDesignCredential())?.accessToken).toBe('sk-env');
  });
});
