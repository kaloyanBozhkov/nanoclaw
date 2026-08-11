/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import fs from 'fs';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import path from 'path';

import {
  type AuthMode,
  parseOrgPlaceholder,
  resolveGroupOrg,
} from './config.js';
import { readEnvFile, readEnvPrefixed } from './env.js';
import { logger } from './logger.js';

export type { AuthMode };

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * The secret for an org, read fresh from .env.
 *
 * Deliberately not captured at startup: adding an identity to .env should take
 * effect on the next container, not the next restart. Reads are cached against
 * the file's mtime so this isn't disk I/O on every API call.
 */
let credentialCache: { mtimeMs: number; values: Record<string, string> } | null =
  null;

function readOrgSecret(envKey: string): string | undefined {
  const envFile = path.join(process.cwd(), '.env');
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(envFile).mtimeMs;
  } catch {
    return undefined;
  }
  if (!credentialCache || credentialCache.mtimeMs !== mtimeMs) {
    credentialCache = {
      mtimeMs,
      values: readEnvPrefixed(''), // every key; filtered by lookup below
    };
  }
  return credentialCache.values[envKey];
}

/**
 * A request carrying a credential header that isn't a `nanoclaw:<org>` routing
 * key gets the default identity. That is correct only for containers older than
 * per-identity routing; anything else is a bug that would run a chat as the
 * wrong account, so say so loudly rather than papering over it.
 */
function logLegacyInjection(header: string, url: string | undefined): void {
  const literal = header.replace(/^Bearer\s+/i, '');
  if (literal !== 'placeholder') return; // a real key passing through; not ours
  logger.warn(
    { url },
    'Credential proxy: request used the legacy "placeholder" credential — ' +
      'serving the DEFAULT identity. A caller is not sending its routing key.',
  );
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';

  // Start from a cold cache so a restart always re-reads .env.
  credentialCache = null;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Which identity is this container running as? The container never
        // holds a real credential — it sends the routing key `nanoclaw:<org>`
        // in whichever header its auth mode uses, and we swap in the secret.
        //
        // In OAuth mode only the token-exchange request carries the key: the
        // temp API key Anthropic mints in response is already scoped to that
        // org, so every later request routes itself and passes through here
        // untouched.
        const routingKey =
          parseOrgPlaceholder(String(headers['authorization'] ?? '')) ??
          parseOrgPlaceholder(String(headers['x-api-key'] ?? ''));

        if (routingKey) {
          const org = resolveGroupOrg(routingKey);
          const secret =
            org && org.name === routingKey
              ? readOrgSecret(org.envKey)
              : undefined;

          if (!org || org.name !== routingKey || !secret) {
            // Fail closed. Falling back to the default identity here would
            // silently bill the wrong account on a typo — the exact mistake
            // this feature exists to prevent.
            logger.error(
              { org: routingKey, url: req.url },
              'Credential proxy: unknown org, refusing request',
            );
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'authentication_error',
                  message: `nanoclaw: unknown org "${routingKey}" — check /org and .env`,
                },
              }),
            );
            return;
          }

          delete headers['authorization'];
          delete headers['x-api-key'];
          if (org.authMode === 'api-key') {
            headers['x-api-key'] = secret;
          } else {
            headers['authorization'] = `Bearer ${secret}`;
          }
        } else if (authMode === 'api-key' && headers['x-api-key']) {
          // Legacy path: a container that predates per-identity routing sends
          // the literal "placeholder". Warn — after the routing key landed,
          // reaching here means some caller hardcoded a credential header and
          // is silently running as the DEFAULT identity rather than its own.
          logLegacyInjection(String(headers['x-api-key']), req.url);
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else if (authMode === 'oauth' && headers['authorization']) {
          logLegacyInjection(String(headers['authorization']), req.url);
          const legacyToken =
            secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
          delete headers['authorization'];
          if (legacyToken) {
            headers['authorization'] = `Bearer ${legacyToken}`;
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
