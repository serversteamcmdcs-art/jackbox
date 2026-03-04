const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createServer: createHttpServer } = require('http');
const httpProxy = require('http-proxy');
const urlModule = require('url');
const path = require('path');

const app = express();

const ECAST_TARGET    = 'https://ecast.jackboxgames.com';
const BLOBCAST_TARGET = 'https://blobcast.jackboxgames.com';

// ── Serve player client ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Ecast proxy (Pack 7+) ─────────────────────────────────────────
const ecastProxy = createProxyMiddleware({
  target: ECAST_TARGET, changeOrigin: true, ws: true,
  pathRewrite: { '^/ecast': '' },
  on: {
    proxyReq(p) { p.setHeader('Host','ecast.jackboxgames.com'); p.setHeader('Origin','https://jackbox.tv'); },
    error(err,_,res) { console.error('[ecast]',err.message); try{res.status(502).json({error:'ecast error'});}catch(_){} }
  }
});
app.use('/ecast', ecastProxy);

// ── Blobcast proxy (Pack 1-6) ─────────────────────────────────────
const blobcastProxy = createProxyMiddleware({
  target: BLOBCAST_TARGET, changeOrigin: true, ws: true,
  pathRewrite: { '^/blobcast': '' },
  on: {
    proxyReq(p) { p.setHeader('Host','blobcast.jackboxgames.com'); p.setHeader('Origin','https://jackbox.tv'); },
    error(err,_,res) { console.error('[blobcast]',err.message); try{res.status(502).json({error:'blobcast error'});}catch(_){} }
  }
});
app.use('/blobcast', blobcastProxy);

// ── REST API proxy ────────────────────────────────────────────────
app.use('/api', createProxyMiddleware({
  target: ECAST_TARGET, changeOrigin: true,
  on: {
    proxyReq(p) { p.setHeader('Host','ecast.jackboxgames.com'); },
    error(err,_,res) { console.error('[api]',err.message); try{res.status(502).json({error:'api error'});}catch(_){} }
  }
}));

// ── WebSocket routing ─────────────────────────────────────────────
const wsProxy = httpProxy.createProxyServer({ secure: true, ws: true });
wsProxy.on('error',(err,_,sock)=>{ console.error('[ws]',err.message); try{sock.end();}catch(_){} });

const PORT = process.env.PORT || 3000;
const server = createHttpServer(app);

server.on('upgrade', (req, socket, head) => {
  const p = urlModule.parse(req.url).pathname || '';
  if (p.startsWith('/ecast')) {
    req.url = req.url.replace(/^\/ecast/,'') || '/';
    wsProxy.ws(req,socket,head,{ target:'wss://ecast.jackboxgames.com', changeOrigin:true,
      headers:{Host:'ecast.jackboxgames.com',Origin:'https://jackbox.tv'} });
  } else if (p.startsWith('/blobcast')) {
    req.url = req.url.replace(/^\/blobcast/,'') || '/';
    wsProxy.ws(req,socket,head,{ target:'wss://blobcast.jackboxgames.com', changeOrigin:true,
      headers:{Host:'blobcast.jackboxgames.com',Origin:'https://jackbox.tv'} });
  } else { socket.end(); }
});

server.listen(PORT, () => {
  console.log(`\n🎮 Jackbox Proxy on :${PORT}`);
  console.log(`   Player client  → http://localhost:${PORT}/`);
  console.log(`   Ecast (Pack7+) → ${ECAST_TARGET}`);
  console.log(`   Blobcast(1-6)  → ${BLOBCAST_TARGET}\n`);
});
