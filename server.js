const express = require('express');
const path = require('path');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000;
const MY_HOST = process.env.RENDER_EXTERNAL_HOSTNAME || 'jackbox-k17q.onrender.com';

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

// ─── Ecast прокси (PP7-PP10) ─────────────────────────────────────────────────
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
        body = body.replace(/https?:\/\/blobcast\.jackboxgames\.com/g, 'https://' + MY_HOST + '/blobcast');
        body = body.replace(/https?:\/\/ecast\.jackboxgames\.com/g, 'https://' + MY_HOST + '/ecast');
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

// ─── jackbox.fun прокси (для игроков с телефонов) ────────────────────────────
const jackboxFunProxy = createProxyMiddleware({
  target: 'https://jackbox.fun',
  changeOrigin: true,
  selfHandleResponse: true,
  ws: true,
  on: {
    proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      const contentType = proxyRes.headers['content-type'] || '';
      // В HTML и JS подменяем все ссылки на серверы Jackbox на наш прокси
      if (contentType.includes('text/html') || contentType.includes('javascript')) {
        let body = responseBuffer.toString('utf8');
        body = body.replace(/https?:\/\/blobcast\.jackboxgames\.com/g, 'https://' + MY_HOST + '/blobcast');
        body = body.replace(/https?:\/\/ecast\.jackboxgames\.com/g, 'https://' + MY_HOST + '/ecast');
        // Убираем CSP заголовки чтобы не блокировали наш контент
        if (res.removeHeader) {
          res.removeHeader('content-security-policy');
          res.removeHeader('x-frame-options');
        }
        return Buffer.from(body, 'utf8');
      }
      return responseBuffer;
    }),
    error: (err, req, res) => {
      console.error('jackbox.fun proxy error:', err.message);
      if (res && res.writeHead) { res.writeHead(502); res.end('jackbox.fun proxy error'); }
    },
  },
});

// ─── Маршруты ────────────────────────────────────────────────────────────────
app.use('/blobcast', blobcastProxy);
app.use('/ecast', ecastProxy);

// Все остальные запросы — проксируем jackbox.fun
// Игроки заходят на https://jackbox-k17q.onrender.com и видят jackbox.fun
app.use('/', jackboxFunProxy);

// ─── Сервер + WebSocket ──────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Jackbox proxy running on 0.0.0.0:' + PORT);
  console.log('My host: ' + MY_HOST);
  console.log('Players open: https://' + MY_HOST);
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url;
  let target;
  if (url.includes('/blobcast') || url.includes('/room/') || url.includes('/socket.io')) {
    target = 'wss://blobcast.jackboxgames.com';
  } else if (url.includes('/ecast')) {
    target = 'wss://ecast.jackboxgames.com';
  } else {
    // WebSocket от jackbox.fun (игровой клиент)
    target = 'wss://jackbox.fun';
  }
  createProxyMiddleware({ target, changeOrigin: true, ws: true }).upgrade(req, socket, head);
});
