/**
 * Host-side OAuth helper for Notion MCP.
 *
 * Performs OAuth 2.1 + PKCE + dynamic client registration against
 * https://mcp.notion.com/mcp, then writes the resulting token bundle to
 * ~/.config/nanoclaw/notion/oauth.json (chmod 600).
 *
 * Container agents mount this file read/write and refresh the access_token
 * themselves under flock. Re-run this script only on first setup or if
 * the refresh chain ever breaks.
 *
 * Usage: npm run notion-auth
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MCP_SERVER = 'https://mcp.notion.com/mcp';
const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const CLIENT_NAME = 'NanoClaw';
// Stored inside a dedicated subdirectory so the directory (not just the file)
// can be bind-mounted into containers. Containers need a shared parent dir
// to host the cross-container lockfile used during refresh-token rotation.
const TOKEN_DIR = path.join(os.homedir(), '.config', 'nanoclaw', 'notion');
const TOKEN_FILE = path.join(TOKEN_DIR, 'oauth.json');

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  // Notion sometimes returns these on the integration endpoint
  workspace_id?: string;
  workspace_name?: string;
  bot_id?: string;
}

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at?: string;
  scope?: string;
  token_endpoint: string;
  client_id: string;
  client_secret?: string;
  registered_at: string;
  refreshed_at: string;
  workspace_id?: string;
  workspace_name?: string;
  bot_id?: string;
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge };
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${init?.method || 'GET'} ${url} → ${res.status} ${res.statusText}\n${text}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}:\n${text}`);
  }
}

async function discoverMetadata(): Promise<OAuthMetadata> {
  const candidates = [
    'https://mcp.notion.com/.well-known/oauth-authorization-server',
    'https://mcp.notion.com/.well-known/openid-configuration',
  ];
  let lastErr: unknown;
  for (const url of candidates) {
    try {
      const meta = (await fetchJson(url)) as OAuthMetadata;
      console.log(`✓ OAuth metadata discovered at ${url}`);
      return meta;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not discover OAuth metadata. Last error:\n${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

async function registerClient(
  registrationEndpoint: string,
): Promise<RegisteredClient> {
  const body = {
    client_name: CLIENT_NAME,
    redirect_uris: [REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  };
  const client = (await fetchJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })) as RegisteredClient;
  console.log(`✓ Dynamic client registered: client_id=${client.client_id}`);
  return client;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === 'darwin'
      ? `open "${url}"`
      : platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.error(`(could not auto-open browser; copy the URL above)`);
    }
  });
}

function waitForCode(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(
          `<h1>Authorization failed</h1><p>${error}: ${url.searchParams.get('error_description') || ''}</p>`,
        );
        server.close();
        reject(new Error(`Notion returned error: ${error}`));
        return;
      }
      if (!code || returnedState !== state) {
        res.writeHead(400, { 'content-type': 'text/html' });
        res.end(
          `<h1>Authorization failed</h1><p>state mismatch or no code</p>`,
        );
        server.close();
        reject(new Error('state mismatch or no code'));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<html><body style="font-family:sans-serif;text-align:center;padding:48px"><h1>✓ NanoClaw connected to Notion</h1><p>You can close this tab.</p></body></html>`,
      );
      server.close();
      resolve(code);
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log(`✓ Waiting for redirect on ${REDIRECT_URI}`);
    });
    server.on('error', reject);
  });
}

async function exchangeCode(
  tokenEndpoint: string,
  code: string,
  verifier: string,
  client: RegisteredClient,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: client.client_id,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  // If a client_secret was issued, prefer Basic auth (RFC 6749 §2.3.1)
  if (client.client_secret) {
    const basic = Buffer.from(
      `${client.client_id}:${client.client_secret}`,
    ).toString('base64');
    headers['authorization'] = `Basic ${basic}`;
  }
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Token exchange failed: ${res.status} ${res.statusText}\n${text}`,
    );
  }
  return JSON.parse(text) as TokenResponse;
}

function logTokenShape(t: TokenResponse): void {
  console.log('');
  console.log('--- Token shape (this drives the refresh strategy) ---');
  console.log(
    `  access_token:  ${t.access_token ? `present (${t.access_token.length} chars)` : 'MISSING'}`,
  );
  console.log(
    `  refresh_token: ${t.refresh_token ? `present (${t.refresh_token.length} chars)` : 'absent (token is non-expiring)'}`,
  );
  console.log(`  expires_in:    ${t.expires_in ?? 'absent (non-expiring)'}`);
  console.log(`  token_type:    ${t.token_type ?? 'absent'}`);
  console.log(`  scope:         ${t.scope ?? 'absent'}`);
  if (t.workspace_name) {
    console.log(`  workspace:     ${t.workspace_name} (${t.workspace_id})`);
  }
  console.log('-------------------------------------------------------');
  console.log('');
}

async function main(): Promise<void> {
  console.log(`Connecting NanoClaw to Notion MCP at ${MCP_SERVER}`);
  console.log('');

  const meta = await discoverMetadata();
  if (!meta.registration_endpoint) {
    throw new Error(
      'OAuth metadata has no registration_endpoint — dynamic client registration not supported. ' +
        'Cannot proceed without admin-issued client credentials.',
    );
  }

  const client = await registerClient(meta.registration_endpoint);

  const { verifier, challenge } = generatePkce();
  const state = base64url(crypto.randomBytes(16));

  const authUrl = new URL(meta.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (meta.scopes_supported?.length) {
    authUrl.searchParams.set('scope', meta.scopes_supported.join(' '));
  }

  console.log('');
  console.log('Opening browser for Notion authorization…');
  console.log(`If it does not open, paste this URL manually:`);
  console.log(`  ${authUrl.toString()}`);
  console.log('');
  console.log(
    '⚠  You will see Notion\'s "select pages to share" screen — pick exactly the pages',
  );
  console.log(
    '   you want the eh-* agents to access. You can change this later in',
  );
  console.log('   Notion → Settings → Connections.');
  console.log('');

  openBrowser(authUrl.toString());
  const code = await waitForCode(state);
  console.log(`✓ Authorization code received`);

  const tokens = await exchangeCode(
    meta.token_endpoint,
    code,
    verifier,
    client,
  );
  console.log(`✓ Tokens obtained`);
  logTokenShape(tokens);

  const now = new Date();
  const expiresAt =
    typeof tokens.expires_in === 'number'
      ? new Date(now.getTime() + tokens.expires_in * 1000).toISOString()
      : undefined;

  const stored: StoredTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type ?? 'Bearer',
    expires_at: expiresAt,
    scope: tokens.scope,
    token_endpoint: meta.token_endpoint,
    client_id: client.client_id,
    client_secret: client.client_secret,
    registered_at: now.toISOString(),
    refreshed_at: now.toISOString(),
    workspace_id: tokens.workspace_id,
    workspace_name: tokens.workspace_name,
    bot_id: tokens.bot_id,
  };

  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(stored, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.chmodSync(TOKEN_FILE, 0o600);
  console.log(`✓ Saved to ${TOKEN_FILE} (chmod 600)`);
  console.log('');
  console.log(
    'Next: rebuild containers (./container/build.sh) and restart NanoClaw',
  );
  console.log('to pick up the Notion MCP server in the eh-* groups.');
}

main().catch((err) => {
  console.error('');
  console.error('✗ notion-auth failed:');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
