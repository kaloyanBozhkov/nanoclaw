/**
 * Minimal Matrix client-server API wrapper — just what the NanoClaw channel
 * needs. Plain fetch, no SDK: the bot runs unencrypted rooms on a private
 * homeserver, so sync/send/upload/download is the whole surface, and owning it
 * keeps authenticated media (Synapse ≥1.120 refuses the legacy unauthenticated
 * download path) and the sync token under our control.
 */

export interface MatrixEvent {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  state_key?: string;
  content: Record<string, any>;
  unsigned?: Record<string, any>;
}

export interface SyncRoom {
  state?: { events?: MatrixEvent[] };
  timeline?: { events?: MatrixEvent[]; limited?: boolean };
}

export interface InvitedRoom {
  invite_state?: { events?: MatrixEvent[] };
}

export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, SyncRoom>;
    invite?: Record<string, InvitedRoom>;
    leave?: Record<string, unknown>;
  };
}

export class MatrixApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly errcode: string | undefined,
    readonly body: string,
  ) {
    super(
      `Matrix ${method} ${path} → ${status}${errcode ? ` ${errcode}` : ''}: ${body.slice(0, 300)}`,
    );
  }
}

/** How often a rate-limited (429) request is retried before giving up. */
const MAX_RATE_LIMIT_RETRIES = 5;
/** Longest single wait honoured from a 429's retry_after_ms. */
const MAX_RETRY_WAIT_MS = 120_000;

export class MatrixClient {
  private txnCounter = 0;

  constructor(
    readonly homeserver: string,
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.homeserver = homeserver.replace(/\/+$/, '');
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.homeserver}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: opts.signal,
      });
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;

      let parsed: { errcode?: string; retry_after_ms?: number } = {};
      try {
        parsed = JSON.parse(text);
      } catch {}
      // Synapse throttles bursts (e.g. creating many rooms) and says how long
      // to wait; honour it rather than failing the caller.
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const wait = Math.min(parsed.retry_after_ms ?? 5000, MAX_RETRY_WAIT_MS);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw new MatrixApiError(method, path, res.status, parsed.errcode, text);
    }
  }

  /** Unique per process — Matrix dedupes sends by (device, txnId). */
  private txnId(): string {
    return `nc${Date.now()}.${++this.txnCounter}`;
  }

  whoami(): Promise<{ user_id: string; device_id?: string }> {
    return this.request('GET', '/_matrix/client/v3/account/whoami');
  }

  sync(
    params: { since?: string; timeout?: number; filter?: string },
    signal?: AbortSignal,
  ): Promise<SyncResponse> {
    const q = new URLSearchParams();
    if (params.since) q.set('since', params.since);
    if (params.timeout !== undefined) q.set('timeout', String(params.timeout));
    if (params.filter) q.set('filter', params.filter);
    return this.request('GET', `/_matrix/client/v3/sync?${q}`, undefined, {
      signal,
    });
  }

  sendEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
  ): Promise<{ event_id: string }> {
    return this.request(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${this.txnId()}`,
      content,
    );
  }

  setTyping(
    roomId: string,
    userId: string,
    typing: boolean,
    timeoutMs = 30000,
  ): Promise<unknown> {
    return this.request(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
      typing ? { typing: true, timeout: timeoutMs } : { typing: false },
    );
  }

  joinRoom(roomId: string): Promise<{ room_id: string }> {
    return this.request(
      'POST',
      `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      {},
    );
  }

  joinedRooms(): Promise<{ joined_rooms: string[] }> {
    return this.request('GET', '/_matrix/client/v3/joined_rooms');
  }

  leaveRoom(roomId: string): Promise<unknown> {
    return this.request(
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
      {},
    );
  }

  /** Private, unencrypted room — the bot can't do E2EE. */
  createRoom(name: string, invite: string[]): Promise<{ room_id: string }> {
    return this.request('POST', '/_matrix/client/v3/createRoom', {
      name,
      preset: 'private_chat',
      visibility: 'private',
      invite,
      // Invitees get the same power as the bot so they can rename the room,
      // change its avatar and so on from Element X.
      power_level_content_override: {
        users: Object.fromEntries(invite.map((u) => [u, 100])),
      },
    });
  }

  getStateEvent<T = Record<string, unknown>>(
    roomId: string,
    type: string,
    stateKey = '',
  ): Promise<T> {
    return this.request(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
    );
  }

  setDisplayName(userId: string, displayname: string): Promise<unknown> {
    return this.request(
      'PUT',
      `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
      { displayname },
    );
  }

  async upload(
    data: Buffer,
    filename: string,
    contentType: string,
  ): Promise<string> {
    const res = await this.fetchImpl(
      `${this.homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': contentType,
        },
        body: new Uint8Array(data),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new MatrixApiError(
        'POST',
        '/_matrix/media/v3/upload',
        res.status,
        undefined,
        text,
      );
    }
    return JSON.parse(text).content_uri as string;
  }

  /** Download an mxc:// URI through the authenticated media endpoint. */
  async download(mxcUri: string): Promise<Buffer> {
    const m = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxcUri);
    if (!m) throw new Error(`Not an mxc URI: ${mxcUri}`);
    const path = `/_matrix/client/v1/media/download/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`;
    const res = await this.fetchImpl(`${this.homeserver}${path}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      throw new MatrixApiError(
        'GET',
        path,
        res.status,
        undefined,
        await res.text(),
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
