#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const EXCLUDED_TOOLS = new Set((process.env.EXCLUDED_TOOLS || '').split(',').filter(Boolean));

const CLIENT_ID = 'llm';
const CLIENT_SECRET = process.env.MCP_CLIENT_SECRET || 'changeme';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '9191');
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '9090');
const INGRESS_HOST = (process.env.INGRESS_HOST || 'http://localhost:9090').replace(/\/$/, '');
const TOKEN_EXPIRY = parseInt(process.env.MCP_TOKEN_EXPIRY || '2592000');
const TOKENS_FILE = '/home/kasm-user/.markers/mcp-tokens.json';

// Auth codes: in-memory only (short-lived, 5 min)
const authCodes = new Map();

// Access tokens: Map of token -> expiresAt (epoch ms), persisted to disk
let accessTokens = new Map();

function loadTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    accessTokens = new Map(Object.entries(data).filter(([, exp]) => exp > now()));
    log('BOOT', `loaded ${accessTokens.size} valid token(s) from disk`);
  } catch (_) {
    accessTokens = new Map();
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(Object.fromEntries(accessTokens)));
  } catch (e) {
    log('WARN', `failed to persist tokens: ${e.message}`);
  }
}

function now() { return Math.floor(Date.now() / 1000); }

function hasValidToken(token) {
  const expiresAt = accessTokens.get(token);
  if (expiresAt === undefined) return false;
  if (now() > expiresAt) {
    accessTokens.delete(token);
    saveTokens();
    return false;
  }
  return true;
}

function log(tag, msg, data) {
  const ts = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[${ts}] [${tag}] ${msg}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] [${tag}] ${msg}`);
  }
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest();
}

function generateToken() {
  return base64url(crypto.randomBytes(32));
}

function verifyPkce(codeVerifier, codeChallenge) {
  const computed = base64url(sha256(codeVerifier));
  const ok = computed === codeChallenge;
  if (!ok) log('PKCE', 'verification failed', { computed, expected: codeChallenge });
  return ok;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseBasicAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    return { clientId: decoded.slice(0, colon), clientSecret: decoded.slice(colon + 1) };
  } catch (_) { return null; }
}

const AUTHORIZE_HTML = (params, error) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenGhiara MCP – Authorize</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1d27; border: 1px solid #2d3148; border-radius: 12px; padding: 2rem; width: 100%; max-width: 400px; }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    p { font-size: 0.875rem; color: #94a3b8; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.4rem; }
    input[type=password] { width: 100%; padding: 0.65rem 0.75rem; border-radius: 6px; border: 1px solid #2d3148; background: #0f1117; color: #e2e8f0; font-size: 0.95rem; outline: none; }
    input[type=password]:focus { border-color: #6366f1; }
    button { margin-top: 1rem; width: 100%; padding: 0.7rem; border-radius: 6px; border: none; background: #6366f1; color: #fff; font-size: 0.95rem; cursor: pointer; }
    button:hover { background: #4f52d8; }
    .error { margin-top: 1rem; padding: 0.6rem 0.75rem; border-radius: 6px; background: #3b1f1f; border: 1px solid #7f1d1d; color: #fca5a5; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>OpenGhiara MCP</h1>
    <p>Enter the MCP client secret to authorize Claude.ai access.</p>
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${esc(params.client_id || '')}">
      <input type="hidden" name="redirect_uri" value="${esc(params.redirect_uri || '')}">
      <input type="hidden" name="code_challenge" value="${esc(params.code_challenge || '')}">
      <input type="hidden" name="code_challenge_method" value="${esc(params.code_challenge_method || '')}">
      <input type="hidden" name="state" value="${esc(params.state || '')}">
      <input type="hidden" name="scope" value="${esc(params.scope || '')}">
      <label for="secret">Client Secret</label>
      <input type="password" id="secret" name="secret" autofocus placeholder="Enter secret…">
      <button type="submit">Authorize</button>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
    </form>
  </div>
</body>
</html>`;

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

loadTokens();

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const reqId = base64url(crypto.randomBytes(4));

  log('REQ', `[${reqId}] ${req.method} ${req.url}`, {
    headers: {
      authorization: req.headers['authorization']
        ? req.headers['authorization'].replace(/Bearer\s+\S+/, 'Bearer [redacted]').replace(/Basic\s+\S+/, 'Basic [redacted]')
        : undefined,
      'content-type': req.headers['content-type'],
      'mcp-session-id': req.headers['mcp-session-id'],
    },
  });

  res.on('finish', () => log('RES', `[${reqId}] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - start}ms)`));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const [pathname, search] = req.url.split('?');
  const qp = new URLSearchParams(search || '');

  // ── RFC 9728: OAuth 2.0 Protected Resource Metadata ────────────────────────
  if (pathname === '/.well-known/oauth-protected-resource' ||
      pathname.startsWith('/.well-known/oauth-protected-resource/')) {
    const body = { resource: INGRESS_HOST, authorization_servers: [INGRESS_HOST] };
    log('META', `[${reqId}] serving protected-resource metadata`, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // ── OAuth metadata ──────────────────────────────────────────────────────────
  if (pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/.well-known/openid-configuration') {
    const body = {
      issuer: INGRESS_HOST,
      authorization_endpoint: `${INGRESS_HOST}/authorize`,
      token_endpoint: `${INGRESS_HOST}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    };
    log('META', `[${reqId}] serving metadata`, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // ── GET /authorize — show login form ────────────────────────────────────────
  if (pathname === '/authorize' && req.method === 'GET') {
    const params = Object.fromEntries(qp.entries());
    log('AUTH', `[${reqId}] GET /authorize`, {
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      scope: params.scope,
      code_challenge_method: params.code_challenge_method,
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(AUTHORIZE_HTML(params, null));
    return;
  }

  // ── POST /authorize — validate secret, issue code, redirect ─────────────────
  if (pathname === '/authorize' && req.method === 'POST') {
    const rawBody = await parseBody(req).catch(() => '');
    const params = new URLSearchParams(rawBody);

    const clientId = params.get('client_id');
    const redirectUri = params.get('redirect_uri');
    const codeChallenge = params.get('code_challenge');
    const codeChallengeMethod = params.get('code_challenge_method');
    const state = params.get('state');
    const secret = params.get('secret');
    const scope = params.get('scope') || '';

    log('AUTH', `[${reqId}] POST /authorize`, {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      code_challenge_method: codeChallengeMethod,
      secret_ok: secret === CLIENT_SECRET,
      client_id_ok: clientId === CLIENT_ID,
    });

    if (clientId !== CLIENT_ID || secret !== CLIENT_SECRET) {
      log('AUTH', `[${reqId}] invalid credentials`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(AUTHORIZE_HTML(Object.fromEntries(params.entries()), 'Invalid secret. Try again.'));
      return;
    }

    if (!redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
      log('AUTH', `[${reqId}] bad request params`, { redirectUri: !!redirectUri, codeChallenge: !!codeChallenge, codeChallengeMethod });
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request: missing redirect_uri, code_challenge or unsupported method');
      return;
    }

    const code = generateToken();
    authCodes.set(code, { clientId, redirectUri, codeChallenge, scope, expiresAt: Date.now() + 300_000 });
    log('AUTH', `[${reqId}] issued auth code, redirecting to callback`, { redirect_uri: redirectUri });

    const dest = new URL(redirectUri);
    dest.searchParams.set('code', code);
    if (state) dest.searchParams.set('state', state);

    res.writeHead(302, { Location: dest.toString() });
    res.end();
    return;
  }

  // ── POST /oauth/token — exchange code for access token ──────────────────────
  if (pathname === '/oauth/token' && req.method === 'POST') {
    const rawBody = await parseBody(req).catch(() => '');
    const params = new URLSearchParams(rawBody);

    let clientId = params.get('client_id');
    let clientSecret = params.get('client_secret');
    const basic = parseBasicAuth(req.headers['authorization']);
    if (basic) {
      log('TOKEN', `[${reqId}] using Basic auth credentials`);
      clientId = basic.clientId;
      clientSecret = basic.clientSecret;
    }

    const grantType = params.get('grant_type');
    const code = params.get('code');
    const codeVerifier = params.get('code_verifier');
    const redirectUri = params.get('redirect_uri');

    log('TOKEN', `[${reqId}] token request`, {
      grant_type: grantType,
      client_id: clientId,
      client_id_ok: clientId === CLIENT_ID,
      secret_ok: clientSecret === CLIENT_SECRET,
      has_code: !!code,
      has_code_verifier: !!codeVerifier,
      redirect_uri: redirectUri,
    });

    if (grantType !== 'authorization_code') {
      log('TOKEN', `[${reqId}] unsupported grant_type: ${grantType}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    const entry = authCodes.get(code);
    if (!entry) {
      log('TOKEN', `[${reqId}] code not found`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code not found' }));
      return;
    }
    if (entry.expiresAt < Date.now()) {
      log('TOKEN', `[${reqId}] code expired`);
      authCodes.delete(code);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }));
      return;
    }

    if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
      log('TOKEN', `[${reqId}] invalid client credentials`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return;
    }

    if (entry.redirectUri !== redirectUri) {
      log('TOKEN', `[${reqId}] redirect_uri mismatch`, { stored: entry.redirectUri, received: redirectUri });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }));
      return;
    }

    if (!codeVerifier || !verifyPkce(codeVerifier, entry.codeChallenge)) {
      log('TOKEN', `[${reqId}] PKCE failed`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }));
      return;
    }

    authCodes.delete(code);

    const accessToken = generateToken();
    accessTokens.set(accessToken, now() + TOKEN_EXPIRY);
    saveTokens();

    const tokenResponse = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_EXPIRY,
      scope: entry.scope || 'claudeai',
    };
    log('TOKEN', `[${reqId}] issued access token`, { expires_in: TOKEN_EXPIRY, scope: tokenResponse.scope, total_tokens: accessTokens.size });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tokenResponse));
    return;
  }

  // ── Everything else: require valid Bearer token, proxy to upstream ───────────
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    log('PROXY', `[${reqId}] missing/invalid Authorization header for ${req.url}`);
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="${INGRESS_HOST}"`,
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const token = authHeader.slice(7);
  if (!hasValidToken(token)) {
    log('PROXY', `[${reqId}] invalid/expired token for ${req.url} (total valid tokens: ${accessTokens.size})`);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_token' }));
    return;
  }

  // Buffer POST bodies so we can (a) detect tools/list and (b) re-send to upstream
  let requestBody = null;
  let isToolsList = false;
  if (req.method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    requestBody = await parseBody(req).catch(() => '');
    try {
      const rpc = JSON.parse(requestBody);
      isToolsList = rpc.method === 'tools/list';
      if (rpc.method === 'tools/call' && EXCLUDED_TOOLS.has(rpc.params?.name)) {
        log('FILTER', `[${reqId}] blocked tools/call for excluded tool: ${rpc.params.name}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          error: { code: -32601, message: `Tool not found: ${rpc.params.name}` },
        }));
        return;
      }
    } catch (_) {}
  }

  log('PROXY', `[${reqId}] proxying ${req.method} ${req.url} -> 127.0.0.1:${UPSTREAM_PORT}`);

  const upstreamHeaders = Object.assign({}, req.headers, {
    host: `127.0.0.1:${UPSTREAM_PORT}`,
  });
  delete upstreamHeaders['authorization'];

  const proxy = http.request({
    hostname: '127.0.0.1',
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers: upstreamHeaders,
  }, (upRes) => {
    log('PROXY', `[${reqId}] upstream responded ${upRes.statusCode}`);

    if (isToolsList && EXCLUDED_TOOLS.size > 0) {
      const isSse = upRes.headers['content-type']?.includes('text/event-stream');
      let body = '';
      upRes.on('data', chunk => { body += chunk; });
      upRes.on('end', () => {
        try {
          let filtered;
          if (isSse) {
            // SSE: rewrite each `data: <json>` line that contains tools
            filtered = body.replace(/^data: (.+)$/gm, (_, json) => {
              try {
                const rpc = JSON.parse(json);
                if (Array.isArray(rpc.result?.tools)) {
                  const before = rpc.result.tools.length;
                  rpc.result.tools = rpc.result.tools.filter(t => !EXCLUDED_TOOLS.has(t.name));
                  log('FILTER', `[${reqId}] tools/list (SSE): excluded ${before - rpc.result.tools.length} tool(s)`);
                }
                return `data: ${JSON.stringify(rpc)}`;
              } catch (_) { return `data: ${json}`; }
            });
          } else {
            const rpc = JSON.parse(body);
            if (Array.isArray(rpc.result?.tools)) {
              const before = rpc.result.tools.length;
              rpc.result.tools = rpc.result.tools.filter(t => !EXCLUDED_TOOLS.has(t.name));
              log('FILTER', `[${reqId}] tools/list: excluded ${before - rpc.result.tools.length} tool(s)`);
            }
            filtered = JSON.stringify(rpc);
          }
          const headers = Object.assign({}, upRes.headers, { 'content-length': String(Buffer.byteLength(filtered)) });
          res.writeHead(upRes.statusCode, headers);
          res.end(filtered);
        } catch (_) {
          res.writeHead(upRes.statusCode, upRes.headers);
          res.end(body);
        }
      });
    } else {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }
  });

  proxy.on('error', (e) => {
    log('PROXY', `[${reqId}] upstream error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_gateway', message: e.message }));
    }
  });

  if (requestBody !== null) {
    proxy.write(requestBody);
    proxy.end();
  } else {
    req.pipe(proxy);
  }
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  log('BOOT', `MCP OAuth2 proxy :${PROXY_PORT} -> upstream 127.0.0.1:${UPSTREAM_PORT}`);
  log('BOOT', `Ingress host: ${INGRESS_HOST}`);
  log('BOOT', `Token expiry: ${TOKEN_EXPIRY}s (${Math.round(TOKEN_EXPIRY / 86400)}d)`);
  log('BOOT', `Client ID: ${CLIENT_ID}`);
  log('BOOT', `Tokens file: ${TOKENS_FILE}`);
});
