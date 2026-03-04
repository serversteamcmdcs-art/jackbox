const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createServer } = require('http');
const httpProxy = require('http-proxy');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check
app.get('/', (req, res) => {
  const host = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
  res.json({
    status: 'ok',
    service: 'Jackbox Proxy',
    usage: {
      'Pack 7-9+ (Ecast)': 'serverUrl=' + host,
      'Pack 1-6 (Blobcast)': 'blobcastServer=' + host
    }
  });
});

app.get('/info', (req, res) => {
  const host = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
  res.json({ ecast: host, blobcast: host, host });
});

// REST прокси — Ecast API v2 (Pack 7+)
app.use('/api/v2', createProxyMiddleware({
  target: 'https://ecast.jackboxgames.com',
  changeOrigin: true,
  secure: true,
  logLevel: 'warn',
  onError: (err, req, res) => {
    console.error('[Ecast REST]', err.message);
    res.status(502).json({ error: 'upstream error' });
  }
}));

// REST прокси — Blobcast (Pack 1-6)
app.use(['/room', '/api/v1'], createProxyMiddleware({
  target: 'https://blobcast.jackboxgames.com',
  changeOrigin: true,
  secure: true,
  logLevel: 'warn',
  onError: (err, req, res) => {
    console.error('[Blobcast REST]', err.message);
    res.status(502).json({ error: 'upstream error' });
  }
}));

const PORT = process.env.PORT || 3000;
const server = createServer(app);

// WebSocket прокси — Ecast
const ecastWsProxy = httpProxy.createProxyServer({
  target: 'wss://ecast.jackboxgames.com',
  ws: true,
  secure: true,
  changeOrigin: true,
});
ecastWsProxy.on('error', (err, req, socket) => {
  console.error('[Ecast WS Error]', err.message);
  try { socket.destroy(); } catch(e) {}
});

// WebSocket прокси — Blobcast / Socket.IO
const blobcastWsProxy = httpProxy.createProxyServer({
  target: 'wss://blobcast.jackboxgames.com',
  ws: true,
  secure: true,
  changeOrigin: true,
});
blobcastWsProxy.on('error', (err, req, socket) => {
  console.error('[Blobcast WS Error]', err.message);
  try { socket.destroy(); } catch(e) {}
});

// Роутинг WebSocket по пути
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  console.log('[WS Upgrade]', url);

  if (url.startsWith('/ecast')) {
    req.url = url.slice('/ecast'.length) || '/';
    ecastWsProxy.ws(req, socket, head);
  } else if (url.startsWith('/blobcast') || url.startsWith('/socket.io')) {
    if (url.startsWith('/blobcast')) {
      req.url = url.slice('/blobcast'.length) || '/';
    }
    blobcastWsProxy.ws(req, socket, head);
  } else {
    // По умолчанию — Ecast (для jbg.config serverUrl=...)
    ecastWsProxy.ws(req, socket, head);
  }
});

server.listen(PORT, () => {
  const host = process.env.RENDER_EXTERNAL_URL || ('http://localhost:' + PORT);
  console.log('\n🎮 Jackbox Proxy запущен!');
  console.log('📌 URL:', host);
  console.log('\n🎯 Настройки для игр:');
  console.log('   Pack 7-9+ (Ecast):    serverUrl=' + host);
  console.log('   Pack 1-6 (Blobcast):  blobcastServer=' + host);
});
