/**
 * Jackbox Proxy Server
 */

const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const HOST = process.env.ACCESSIBLE_HOST || 'localhost';

const ECAST_HOST    = 'ecast.jackboxgames.com';
const BLOBCAST_HOST = 'blobcast.jackboxgames.com';
const ECAST_WS      = `wss://${ECAST_HOST}`;
const BLOBCAST_WS   = `wss://${BLOBCAST_HOST}`;

// Папка со статикой
const CLIENT_DIR = path.join(__dirname, 'client');

// MIME типы
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

function serveStatic(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Корень — отдаём client/index.htm
  if (pathname === '/' || pathname === '') {
    const indexPath = path.join(CLIENT_DIR, 'index.htm');
    if (fs.existsSync(indexPath)) {
      serveStatic(indexPath, res);
    } else {
      const fallback = path.join(CLIENT_DIR, 'index.html');
      if (fs.existsSync(fallback)) {
        serveStatic(fallback, res);
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(`Замена серверам джекбокса для России`);
      }
    }
    return;
  }

  // Статические файлы из папки client/
  const staticPath = path.join(CLIENT_DIR, pathname);
  if (staticPath.startsWith(CLIENT_DIR) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    serveStatic(staticPath, res);
    return;
  }

  // Всё остальное — проксируем на официальный ecast
  proxyHttpRequest(req, res, ECAST_HOST);
});

function proxyHttpRequest(req, res, targetHost) {
  let body = [];

  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    const bodyData = Buffer.concat(body);

    const options = {
      hostname: targetHost,
      port: 443,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: targetHost,
        'x-forwarded-for': req.socket.remoteAddress,
      },
    };

    delete options.headers['content-length'];
    if (bodyData.length > 0) {
      options.headers['content-length'] = bodyData.length;
    }

    const proxy = https.request(options, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      headers['access-control-allow-origin'] = '*';
      headers['access-control-allow-headers'] = 'Content-Type, Authorization';

      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });

    proxy.on('error', (err) => {
      console.error(`[HTTP PROXY] Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy error', message: err.message }));
      }
    });

    if (bodyData.length > 0) proxy.write(bodyData);
    proxy.end();
  });
}

function createWsProxy(targetUrlBase) {
  return function handleClientWs(clientWs, request) {
    const clientPath = request.url || '/';
    const targetUrl  = targetUrlBase + clientPath;

    console.log(`[WS PROXY] ${request.socket.remoteAddress} → ${targetUrl}`);

    const targetWs = new WebSocket(targetUrl, {
      headers: {
        'origin': 'https://jackbox.tv',
        'user-agent': request.headers['user-agent'] || 'Mozilla/5.0',
      },
      rejectUnauthorized: false,
    });

    const queue = [];

    clientWs.on('message', (data, isBinary) => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data, { binary: isBinary });
      } else {
        queue.push({ data, isBinary });
      }
    });

    targetWs.on('open', () => {
      while (queue.length > 0) {
        const { data, isBinary } = queue.shift();
        targetWs.send(data, { binary: isBinary });
      }
    });

    targetWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    clientWs.on('close', (code, reason) => {
      if (targetWs.readyState === WebSocket.OPEN || targetWs.readyState === WebSocket.CONNECTING) {
        targetWs.close(code, reason);
      }
    });

    targetWs.on('close', (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(code, reason);
      }
    });

    clientWs.on('error', (err) => {
      console.error(`[WS CLIENT] Error: ${err.message}`);
      targetWs.terminate();
    });

    targetWs.on('error', (err) => {
      console.error(`[WS TARGET → ${targetUrlBase}] Error: ${err.message}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, 'upstream error');
      }
    });
  };
}

const ecastWss    = new WebSocketServer({ noServer: true });
const blobcastWss = new WebSocketServer({ noServer: true });

ecastWss.on('connection',    createWsProxy(ECAST_WS));
blobcastWss.on('connection', createWsProxy(BLOBCAST_WS));

server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname || '/';

  const isBlobcast =
    pathname.startsWith('/socket.io') ||
    pathname.startsWith('/blobcast')  ||
    pathname.includes('EIO=');

  if (isBlobcast) {
    blobcastWss.handleUpgrade(request, socket, head, (ws) => {
      blobcastWss.emit('connection', ws, request);
    });
  } else {
    ecastWss.handleUpgrade(request, socket, head, (ws) => {
      ecastWss.emit('connection', ws, request);
    });
  }
});

server.listen(PORT, () => {
  console.log(`
✅ Jackbox Proxy Server запущен на порту ${PORT}
   Твой домен:    ${HOST}
   Главная:       https://${HOST} → ./client/index.htm
   Ecast прокси:  wss://${HOST}  →  ${ECAST_WS}
   Blobcast:      wss://${HOST}  →  ${BLOBCAST_WS}
   HTTP API:      https://${HOST} →  https://${ECAST_HOST}

   Используй в игре:
   -jbg.config serverUrl=${HOST}
`);
});
