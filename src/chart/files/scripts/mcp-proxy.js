#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');

const CLIENT_ID = 'llm';
const CLIENT_SECRET = process.env.MCP_CLIENT_SECRET || 'changeme';
const UPSTREAM_PORT = parseInt(process.env.UPSTREAM_PORT || '9191');
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '9090');
const INGRESS_HOST = process.env.INGRESS_HOST || 'http://localhost:9090';
const TOKEN_EXPIRY = 3600;

function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', CLIENT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = crypto.createHmac('sha256', CLIENT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function parseBasicAuth(authHeader) {
  if (!authHeader || !authHeader.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    return { clientId: decoded.slice(0, colon), clientSecret: decoded.slice(colon + 1) };
  } catch (_) {
    return null;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = req.url.split('?')[0];

  // OAuth2 Authorization Server Metadata (RFC 8414)
  if (pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/.well-known/openid-configuration') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      issuer: INGRESS_HOST,
      token_endpoint: `${INGRESS_HOST}/oauth/token`,
      grant_types_supported: ['client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      response_types_supported: ['token'],
    }));
    return;
  }

  // Token endpoint
  if (pathname === '/oauth/token' && req.method === 'POST') {
    let clientId, clientSecret;

    // Try Basic auth first
    const basic = parseBasicAuth(req.headers['authorization']);
    if (basic) {
      clientId = basic.clientId;
      clientSecret = basic.clientSecret;
    }

    // Then form body
    const rawBody = await parseBody(req).catch(() => '');
    const params = new URLSearchParams(rawBody);

    if (!clientId) clientId = params.get('client_id');
    if (!clientSecret) clientSecret = params.get('client_secret');

    if (params.get('grant_type') !== 'client_credentials' ||
        clientId !== CLIENT_ID ||
        clientSecret !== CLIENT_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client' }));
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const token = signToken({ sub: CLIENT_ID, iat: now, exp: now + TOKEN_EXPIRY });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: token,
      token_type: 'Bearer',
      expires_in: TOKEN_EXPIRY,
    }));
    return;
  }

  // All other paths require Bearer token
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer realm="${INGRESS_HOST}/oauth/token"`,
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (!verifyToken(authHeader.slice(7))) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_token' }));
    return;
  }

  // Proxy to upstream — strip Authorization so upstream doesn't see our token
  const upstreamHeaders = Object.assign({}, req.headers, {
    host: `127.0.0.1:${UPSTREAM_PORT}`,
  });
  delete upstreamHeaders['authorization'];

  const options = {
    hostname: '127.0.0.1',
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers: upstreamHeaders,
  };

  const proxy = http.request(options, (upRes) => {
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
  console.log(`MCP OAuth2 proxy on :${PROXY_PORT} -> upstream 127.0.0.1:${UPSTREAM_PORT}`);
  console.log(`Token endpoint: ${INGRESS_HOST}/oauth/token  client_id=${CLIENT_ID}`);
});
