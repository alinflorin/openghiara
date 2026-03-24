#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');

const CLIENT_ID = 'llm';
const CLIENT_SECRET = process.env.MCP_CLIENT_SECRET || 'changeme';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '9191');
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '9090');
const INGRESS_HOST = (process.env.INGRESS_HOST || 'http://localhost:9090').replace(/\/$/, '');
const TOKEN_EXPIRY = 3600;

// In-memory stores (single-instance desktop, no persistence needed)
const authCodes = new Map();   // code -> { clientId, redirectUri, codeChallenge, expiresAt }
const accessTokens = new Set();

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
  return base64url(sha256(codeVerifier)) === codeChallenge;
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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  const [pathname, search] = req.url.split('?');
  const qp = new URLSearchParams(search || '');

  // ── OAuth metadata ──────────────────────────────────────────────────────────
  if (pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/.well-known/openid-configuration') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: INGRESS_HOST,
      authorization_endpoint: `${INGRESS_HOST}/authorize`,
      token_endpoint: `${INGRESS_HOST}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    }));
    return;
  }

  // ── GET /authorize — show login form ────────────────────────────────────────
  if (pathname === '/authorize' && req.method === 'GET') {
    const params = Object.fromEntries(qp.entries());
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

    // Re-render form with error on bad secret or client_id
    if (clientId !== CLIENT_ID || secret !== CLIENT_SECRET) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(AUTHORIZE_HTML(Object.fromEntries(params.entries()), 'Invalid secret. Try again.'));
      return;
    }

    if (!redirectUri || !codeChallenge || codeChallengeMethod !== 'S256') {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request: missing redirect_uri, code_challenge or unsupported method');
      return;
    }

    const code = generateToken();
    authCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      expiresAt: Date.now() + 300_000, // 5 min
    });

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
    if (basic) { clientId = basic.clientId; clientSecret = basic.clientSecret; }

    const grantType = params.get('grant_type');
    const code = params.get('code');
    const codeVerifier = params.get('code_verifier');
    const redirectUri = params.get('redirect_uri');

    if (grantType !== 'authorization_code') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    const entry = authCodes.get(code);
    if (!entry || entry.expiresAt < Date.now()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant' }));
      return;
    }

    if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return;
    }

    if (entry.redirectUri !== redirectUri) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }));
      return;
    }

    if (!codeVerifier || !verifyPkce(codeVerifier, entry.codeChallenge)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' }));
      return;
    }

    authCodes.delete(code);

    const accessToken = generateToken();
    accessTokens.add(accessToken);
    // Auto-expire token from memory after TOKEN_EXPIRY
    setTimeout(() => accessTokens.delete(accessToken), TOKEN_EXPIRY * 1000);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_EXPIRY,
    }));
    return;
  }

  // ── Everything else: require valid Bearer token, proxy to upstream ───────────
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="${INGRESS_HOST}"`,
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const token = authHeader.slice(7);
  if (!accessTokens.has(token)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_token' }));
    return;
  }

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
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });

  proxy.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_gateway', message: e.message }));
    }
  });

  req.pipe(proxy);
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`MCP OAuth2 proxy :${PROXY_PORT} -> upstream 127.0.0.1:${UPSTREAM_PORT}`);
  console.log(`Authorization endpoint: ${INGRESS_HOST}/authorize`);
});
