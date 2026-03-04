const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// Твой домен на Render (подставляется автоматически)
const MY_HOST = process.env.RENDER_EXTERNAL_HOSTNAME || 'jackbox-proxy.onrender.com';

// ─── Blobcast прокси (PP1-PP6) ───────────────────────────────────────────────
const blobcastProxy = createProxyMiddleware({
  target: 'https://blobcast.jackboxgames.com',
  changeOrigin: true,
  ws: true,
  pathRewrite: { '^/blobcast': '' },
  on: {
    error: (err, req, res) => {
      console.error('Blobcast error:', err.message);
      if (res && res.writeHead) { res.writeHead(502); res.end('Blobcast proxy error'); }
    },
  },
});

// ─── Ecast прокси (PP7-PP10) с подменой URL в ответе ────────────────────────
const ecastProxy = createProxyMiddleware({
  target: 'https://ecast.jackboxgames.com',
  changeOrigin: true,
  selfHandleResponse: true,
  ws: true,
  pathRewrite: { '^/ecast': '' },
  on: {
    proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      const contentType = proxyRes.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        let body = responseBuffer.toString('utf8');
        // Подменяем blobcast адрес на наш прокси (для PP6)
        body = body.replace(
          /https?:\/\/blobcast\.jackboxgames\.com/g,
          'https://' + MY_HOST + '/blobcast'
        );
        // Подменяем ecast адрес на наш прокси
        body = body.replace(
          /https?:\/\/ecast\.jackboxgames\.com/g,
          'https://' + MY_HOST + '/ecast'
        );
        return Buffer.from(body, 'utf8');
      }
      return responseBuffer;
    }),
    error: (err, req, res) => {
      console.error('Ecast error:', err.message);
      if (res && res.writeHead) { res.writeHead(502); res.end('Ecast proxy error'); }
    },
  },
});

// ─── Маршруты ────────────────────────────────────────────────────────────────
app.use('/blobcast', blobcastProxy);
app.use('/ecast', ecastProxy);

// Fallback
app.use('/', (req, res, next) => {
  const url = req.url;
  if (url.includes('/room/') || url.includes('/socket.io')) {
    return blobcastProxy(req, res, next);
  }
  return ecastProxy(req, res, next);
});

// ─── Сервер + WebSocket ──────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log('Jackbox proxy running on port ' + PORT);
  console.log('My host: ' + MY_HOST);
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url;
  let target;
  if (url.includes('/blobcast') || url.includes('/room/') || url.includes('/socket.io')) {
    target = 'wss://blobcast.jackboxgames.com';
  } else {
    target = 'wss://ecast.jackboxgames.com';
  }
  createProxyMiddleware({ target, changeOrigin: true, ws: true }).upgrade(req, socket, head);
});
