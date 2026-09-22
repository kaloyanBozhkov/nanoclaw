/**
 * Claude Design access probe.
 *
 * The design MCP server is wired into every container by the agent-runner
 * whenever ANTHROPIC_BASE_URL is set. When the identity's OAuth token lacks the
 * design scopes the server 403s during connect, the SDK silently drops it, and
 * the agent sees only an absent `mcp__design__*` — with no way to tell "not
 * installed" from "not authorized". It then guesses, badly.
 *
 * So we ask at startup and say so plainly in the log.
 */

import { request } from 'http';

import { CREDENTIAL_PROXY_PORT, orgPlaceholder } from './config.js';
import { logger } from './logger.js';

export interface DesignProbeResult {
  ok: boolean;
  status?: number;
  /** Machine-readable error code from the API, e.g. `needs_design_scopes`. */
  code?: string;
  /** Remediation text from the API, passed through verbatim. */
  hint?: string;
}

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nanoclaw-probe', version: '1' },
  },
});

/**
 * Ask the design MCP endpoint whether this org's credential is accepted, via
 * the credential proxy so the real token never leaves the host's own process.
 */
export function probeDesignAccess(
  orgName: string,
  timeoutMs = 5000,
): Promise<DesignProbeResult> {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: CREDENTIAL_PROXY_PORT,
        path: '/v1/design/mcp',
        method: 'POST',
        headers: {
          authorization: `Bearer ${orgPlaceholder(orgName)}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(INITIALIZE_BODY),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString('utf-8');
          if (status >= 200 && status < 300) {
            resolve({ ok: true, status });
            return;
          }
          let code: string | undefined;
          let hint: string | undefined;
          try {
            const parsed = JSON.parse(body) as {
              error?: string;
              prompt?: string;
            };
            if (typeof parsed.error === 'string') code = parsed.error;
            if (typeof parsed.prompt === 'string') hint = parsed.prompt;
          } catch {
            // Non-JSON error body — the status code is still worth reporting.
          }
          resolve({ ok: false, status, code, hint });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, code: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, code: err.message }));
    req.end(INITIALIZE_BODY);
  });
}

/**
 * Probe at startup and log the outcome. Never throws and never blocks boot —
 * design access is optional, but a silent 403 costs hours to diagnose.
 */
export async function logDesignAccessStatus(orgName: string): Promise<void> {
  try {
    const result = await probeDesignAccess(orgName);
    if (result.ok) {
      logger.info({ org: orgName }, 'Claude Design access OK (mcp__design__*)');
      return;
    }
    if (result.code === 'needs_design_scopes') {
      logger.warn(
        { org: orgName, status: result.status, hint: result.hint },
        'Claude Design UNAVAILABLE — this org’s OAuth token lacks the design scopes. ' +
          'The design MCP server will fail to connect and mcp__design__* will be absent in containers. ' +
          'Run /design-login in Claude Code, re-mint the token with `claude setup-token`, and update .env.',
      );
      return;
    }
    logger.warn(
      { org: orgName, status: result.status, code: result.code, hint: result.hint },
      'Claude Design UNAVAILABLE — mcp__design__* will be absent in containers',
    );
  } catch (err) {
    logger.warn({ err, org: orgName }, 'Claude Design probe failed');
  }
}
