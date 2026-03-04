const express = require('express');
const path = require('path');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 10000;
const MY_HOST = process.env.RENDER_EXTERNAL_HOSTNAME || 'jackbox-k17q.onrender.com';

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

// Главная страница
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use('/blobcast', blobcastProxy);
app.use('/ecast', ecastProxy);

app.use('/', (req, res, next) => {
  const url = req.url;
  if (url.includes('/room/') || url.includes('/socket.io')) {
    return blobcastProxy(req, res, next);
  }
  return ecastProxy(req, res, next);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Jackbox proxy running on 0.0.0.0:' + PORT);
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
