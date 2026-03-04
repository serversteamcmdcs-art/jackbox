const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

function makeProxy(target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true,
    on: {
      error: (err, req, res) => {
        console.error('Proxy error:', err.message);
        if (res && res.writeHead) {
          res.writeHead(502);
          res.end('Proxy error');
        }
      },
    },
  });
}

// PP1-PP6 (Blobcast)
const blobcastProxy = makeProxy('https://blobcast.jackboxgames.com');
app.use('/blobcast', blobcastProxy);

// PP7-PP10 (Ecast)
const ecastProxy = makeProxy('https://ecast.jackboxgames.com');
app.use('/ecast', ecastProxy);

// Auto-detect fallback
app.use('/', (req, res, next) => {
  const url = req.url;
  if (url.includes('/room/') || url.includes('/socket.io')) {
    return blobcastProxy(req, res, next);
  }
  return ecastProxy(req, res, next);
});

const server = app.listen(PORT, () => {
  console.log('Jackbox proxy running on port ' + PORT);
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
