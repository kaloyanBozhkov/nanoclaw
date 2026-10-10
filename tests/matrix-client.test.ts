import { describe, it, expect, vi } from 'vitest';

import { MatrixApiError, MatrixClient } from '../src/channels/matrix-client.js';

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('MatrixClient rate limiting', () => {
  it('waits retry_after_ms and retries a 429', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        respond(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1 }),
      )
      .mockResolvedValueOnce(respond(200, { room_id: '!r:x' }));
    const client = new MatrixClient('http://hs', 'tok', fetchImpl);

    await expect(client.createRoom('Main', ['@koko:x'])).resolves.toEqual({
      room_id: '!r:x',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after repeated 429s', async () => {
    const fetchImpl = vi.fn(async () =>
      respond(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1 }),
    );
    const client = new MatrixClient('http://hs', 'tok', fetchImpl);

    const err = await client.whoami().catch((e) => e);
    expect(err).toBeInstanceOf(MatrixApiError);
    expect(err.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('does not retry other errors', async () => {
    const fetchImpl = vi.fn(async () =>
      respond(403, { errcode: 'M_FORBIDDEN' }),
    );
    const client = new MatrixClient('http://hs', 'tok', fetchImpl);

    const err = await client.whoami().catch((e) => e);
    expect(err.errcode).toBe('M_FORBIDDEN');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
