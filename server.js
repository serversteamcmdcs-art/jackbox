/**
 * Jackbox Proxy Server
 * Точная копия jb-ecast.klucva.ru — прокси к официальным серверам Jackbox.
 *
 * Как работает:
 *  - HTTP API запросы → проксирует на ecast.jackboxgames.com
 *  - Ecast WebSocket  → проксирует на wss://ecast.jackboxgames.com
 *  - Blobcast Socket.IO → проксирует на wss://blobcast.jackboxgames.com
 *
 * Деплой: Render.com / Railway / любой Node хостинг
 * Переменные окружения:
 *   PORT            — порт (Render проставляет сам)
 *   ACCESSIBLE_HOST — твой домен (твой-сервис.onrender.com)
 */

const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.ACCESSIBLE_HOST || 'localhost';



const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'client/index.htm');




// ─── Официальные серверы Jackbox ───────────────────────────────────────────────
const ECAST_HOST    = 'ecast.jackboxgames.com';
const BLOBCAST_HOST = 'blobcast.jackboxgames.com';
const ECAST_WS      = `wss://${ECAST_HOST}`;
const BLOBCAST_WS   = `wss://${BLOBCAST_HOST}`;

// ─── HTTP сервер ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  // CORS для jackbox.fun и jackbox.tv
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Корень — заглушка как у оригинала
  if (path === '/' || path === '') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(`Замена серверам джекбокса для России`);
    return;
  }

  // Всё остальное — проксируем на официальный ecast
  proxyHttpRequest(req, res, ECAST_HOST);
});

// ─── HTTP прокси ───────────────────────────────────────────────────────────────
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

    // Убираем заголовки которые ломают прокси
    delete options.headers['content-length'];
    if (bodyData.length > 0) {
      options.headers['content-length'] = bodyData.length;
    }

    const proxy = https.request(options, (proxyRes) => {
      // Добавляем CORS к ответу от jackbox
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

// ─── WebSocket прокси (универсальный) ─────────────────────────────────────────
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

    // Буфер сообщений пока target не открылся
    const queue = [];

    // Клиент → Jackbox
    clientWs.on('message', (data, isBinary) => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data, { binary: isBinary });
      } else {
        queue.push({ data, isBinary });
      }
    });

    // Jackbox → Клиент
    targetWs.on('open', () => {
      // Слить буфер
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

    // Закрытия
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

    // Ошибки
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

// ─── WebSocket серверы ─────────────────────────────────────────────────────────
// Ecast WS: /api/v2/rooms/... и /ecast/...
const ecastWss    = new WebSocketServer({ noServer: true });
// Blobcast Socket.IO polling/ws: /socket.io/... и /blobcast/...
const blobcastWss = new WebSocketServer({ noServer: true });

ecastWss.on('connection',    createWsProxy(ECAST_WS));
blobcastWss.on('connection', createWsProxy(BLOBCAST_WS));

// ─── HTTP Upgrade → правильный WSS ────────────────────────────────────────────
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname || '/';

  // Blobcast: Socket.IO пути и старые /socket.io/
  const isBlobcast =
    pathname.startsWith('/socket.io') ||
    pathname.startsWith('/blobcast')  ||
    pathname.includes('EIO=');         // socket.io query fallback

  if (isBlobcast) {
    blobcastWss.handleUpgrade(request, socket, head, (ws) => {
      blobcastWss.emit('connection', ws, request);
    });
  } else {
    // Всё остальное (Ecast, /api/v2/, /ecast) → ecast
    ecastWss.handleUpgrade(request, socket, head, (ws) => {
      ecastWss.emit('connection', ws, request);
    });
  }
});

// ─── Запуск ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
✅ Jackbox Proxy Server запущен на порту ${PORT}
   Твой домен:    ${HOST}
   Ecast прокси:  wss://${HOST}  →  ${ECAST_WS}
   Blobcast:      wss://${HOST}  →  ${BLOBCAST_WS}
   HTTP API:      https://${HOST} →  https://${ECAST_HOST}

   Используй в игре:
   -jbg.config serverUrl=${HOST}
`);
});
