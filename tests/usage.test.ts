import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/env.js', () => ({
  readEnvFile: vi.fn(() => ({ ORG_TOKEN: 'tok' })),
}));

import { fetchOrgUsage, formatUsage, parseUsageHeaders } from '../src/usage.js';

const NOW = new Date('2026-10-12T18:00:00Z');
const at = (iso: string) => String(Date.parse(iso) / 1000);

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.79',
    'anthropic-ratelimit-unified-5h-reset': at('2026-10-12T19:52:00Z'),
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.21',
    'anthropic-ratelimit-unified-7d-reset': at('2026-10-14T08:42:00Z'),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    ...extra,
  });
}

describe('parseUsageHeaders', () => {
  it('reads both windows', () => {
    const u = parseUsageHeaders(headers())!;
    expect(u.fiveHour?.utilization).toBe(0.79);
    expect(u.sevenDay?.resetsAt?.toISOString()).toBe(
      '2026-10-14T08:42:00.000Z',
    );
    expect(u.binding).toBe('five_hour');
  });

  it('is null when the response has no usage headers', () => {
    expect(parseUsageHeaders(new Headers())).toBeNull();
  });
});

describe('formatUsage', () => {
  it('shows used, left and when each window resets', () => {
    const text = formatUsage(
      'eh_work',
      parseUsageHeaders(headers())!,
      NOW,
      'UTC',
    );
    expect(text).toContain('**Usage — eh_work**');
    expect(text).toContain('▓▓▓▓▓▓▓▓░░ 79% used, 21% left — resets in 1h 52m');
    expect(text).toContain('21% used, 79% left — resets in 38h 42m');
    expect(text).not.toContain('Extra usage');
  });

  it('flags a limited org and enabled extra usage', () => {
    const text = formatUsage(
      'x',
      parseUsageHeaders(
        headers({
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-overage-status': 'allowed',
        }),
      )!,
      NOW,
      'UTC',
    );
    expect(text).toContain('⚠️ rejected');
    expect(text).toContain('Currently **rejected**');
    expect(text).toContain('Extra usage beyond the plan is enabled.');
  });
});

describe('fetchOrgUsage', () => {
  const org = { name: 'work', authMode: 'oauth' as const, envKey: 'ORG_TOKEN' };

  it('sends a minimal Claude Code-shaped request with the org token', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { headers: headers() }),
    );
    const usage = await fetchOrgUsage(org, fetchImpl);
    expect(usage.fiveHour?.utilization).toBe(0.79);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok');
    expect(h['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(JSON.parse(String(init.body)).max_tokens).toBe(1);
  });

  it('still reads usage from a 429', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 429, headers: headers() }),
    );
    await expect(fetchOrgUsage(org, fetchImpl)).resolves.toBeTruthy();
  });

  it('explains API-key orgs and missing headers', async () => {
    await expect(
      fetchOrgUsage({ ...org, authMode: 'api-key' }, vi.fn()),
    ).rejects.toThrow(/API key/);
    const bare = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(fetchOrgUsage(org, bare)).rejects.toThrow(/HTTP 401/);
  });
});
