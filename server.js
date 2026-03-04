const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createServer: createHttpServer } = require('http');
const httpProxy = require('http-proxy');
const urlModule = require('url');

const app = express();

const ECAST_TARGET    = 'https://ecast.jackboxgames.com';
const BLOBCAST_TARGET = 'https://blobcast.jackboxgames.com';

// ── Health check ──────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, connections: activeSockets.size }));
app.get('/', (_req, res) => res.json({
  service: 'Jackbox Universal Proxy',
  ecast:    'wss://YOURHOST.onrender.com/ecast    (Pack 7+)',
  blobcast: 'wss://YOURHOST.onrender.com/blobcast (Pack 1-6)',
}));

// ── Ecast proxy (Pack 7+) ─────────────────────────────────────────
const ecastProxy = createProxyMiddleware({
  target: ECAST_TARGET, changeOrigin: true, ws: true,
  pathRewrite: { '^/ecast': '' },
  on: {
    proxyReq(p) {
      p.setHeader('Host', 'ecast.jackboxgames.com');
      p.setHeader('Origin', 'https://jackbox.tv');
    },
    error(err, _req, res) {
      console.error('[ecast]', err.message);
      try { res.status(502).json({ error: 'ecast error' }); } catch(_) {}
    }
  }
});
app.use('/ecast', ecastProxy);

// ── Blobcast proxy (Pack 1-6) ─────────────────────────────────────
const blobcastProxy = createProxyMiddleware({
  target: BLOBCAST_TARGET, changeOrigin: true, ws: true,
  pathRewrite: { '^/blobcast': '' },
  on: {
    proxyReq(p) {
      p.setHeader('Host', 'blobcast.jackboxgames.com');
      p.setHeader('Origin', 'https://jackbox.tv');
    },
    error(err, _req, res) {
      console.error('[blobcast]', err.message);
      try { res.status(502).json({ error: 'blobcast error' }); } catch(_) {}
    }
  }
});
app.use('/blobcast', blobcastProxy);

// ── REST API proxy (/api/v2/rooms) ────────────────────────────────
app.use('/api', createProxyMiddleware({
  target: ECAST_TARGET, changeOrigin: true,
  on: {
    proxyReq(p) { p.setHeader('Host', 'ecast.jackboxgames.com'); },
    error(err, _req, res) {
      console.error('[api]', err.message);
      try { res.status(502).json({ error: 'api error' }); } catch(_) {}
    }
  }
}));

// ── WebSocket proxy + keepalive ───────────────────────────────────
const wsProxy = httpProxy.createProxyServer({ secure: true, ws: true });

// Track active client sockets
const activeSockets = new Set();

wsProxy.on('error', (err, _req, sock) => {
  console.error('[ws error]', err.message);
  try { sock.end(); } catch(_) {}
});

// Keepalive on the upstream socket (proxy → Jackbox)
wsProxy.on('open', (proxySocket) => {
  proxySocket.setKeepAlive(true, 10000);
});

// Ping all client sockets every 20s to prevent Render closing idle connections
setInterval(() => {
  let alive = 0;
  for (const sock of activeSockets) {
    if (sock.destroyed || !sock.writable) { activeSockets.delete(sock); continue; }
    try { sock.setKeepAlive(true, 10000); alive++; } catch(_) { activeSockets.delete(sock); }
  }
  if (alive > 0) console.log(`[keepalive] ${alive} socket(s) active`);
}, 20000);

const PORT = process.env.PORT || 3000;
const server = createHttpServer(app);

server.on('upgrade', (req, socket, head) => {
  const pathname = urlModule.parse(req.url).pathname || '';

  // Track + enable TCP keepalive immediately on connect
  socket.setKeepAlive(true, 10000);
  activeSockets.add(socket);
  socket.once('close', () => activeSockets.delete(socket));
  socket.once('error', () => activeSockets.delete(socket));

  if (pathname.startsWith('/ecast')) {
    req.url = req.url.replace(/^\/ecast/, '') || '/';
    console.log(`[ws] ecast → ${req.url}`);
    wsProxy.ws(req, socket, head, {
      target: 'wss://ecast.jackboxgames.com',
      changeOrigin: true,
      headers: { Host: 'ecast.jackboxgames.com', Origin: 'https://jackbox.tv' }
    });

  } else if (pathname.startsWith('/blobcast')) {
    req.url = req.url.replace(/^\/blobcast/, '') || '/';
    console.log(`[ws] blobcast → ${req.url}`);
    wsProxy.ws(req, socket, head, {
      target: 'wss://blobcast.jackboxgames.com',
      changeOrigin: true,
      headers: { Host: 'blobcast.jackboxgames.com', Origin: 'https://jackbox.tv' }
    });

  } else {
    console.warn(`[ws] unknown path: ${pathname}`);
    socket.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n🎮 Jackbox Universal Proxy on port ${PORT}`);
  console.log(`   Ecast    (Pack 7+)  → ${ECAST_TARGET}`);
  console.log(`   Blobcast (Pack 1-6) → ${BLOBCAST_TARGET}`);
  console.log(`   Keepalive ping      → every 20s\n`);
});
