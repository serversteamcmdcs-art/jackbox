const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Хелпер: прокси с WebSocket ────────────────────────────────────────────
function makeProxy(target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true, // важно для Socket.IO и WS
    on: {
      error: (err, req, res) => {
        console.error('Proxy error:', err.message);
        if (res?.writeHead) {
          res.writeHead(502);
          res.end('Proxy error');
        }
      },
    },
  });
}

// ─── Маршруты ───────────────────────────────────────────────────────────────

// Старые игры: PP1–PP6, Quiplash 1–2, Fibbage 1–2
// Игра должна иметь serverUrl = твой-домен/blobcast
app.use('/blobcast', makeProxy('https://blobcast.jackboxgames.com'));

// Новые игры: PP7–PP10, Drawful 2 International
// Игра должна иметь serverUrl = твой-домен/ecast
app.use('/ecast', makeProxy('https://ecast.jackboxgames.com'));

// ─── Fallback: автоопределение по хосту ─────────────────────────────────────
// Если serverUrl указан напрямую без пути — угадываем по User-Agent / запросу
app.use('/', (req, res, next) => {
  const url = req.url;
  if (url.includes('/room/') || url.includes('/socket.io')) {
    return makeProxy('https://blobcast.jackboxgames.com')(req, res, next);
  }
  return makeProxy('https://ecast.jackboxgames.com')(req, res, next);
});

// ─── Запуск ─────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`Jackbox proxy running on port ${PORT}`);
});

// WebSocket поддержка (нужна для Socket.IO в blobcast)
server.on('upgrade', (req, socket, head) => {
  const url = req.url;
  let target;
  if (url.includes('/blobcast') || url.includes('/room/') || url.includes('/socket.io')) {
    target = 'wss://blobcast.jackboxgames.com';
  } else {
    target = 'wss://ecast.jackboxgames.com';
  }
  const proxy = createProxyMiddleware({ target, changeOrigin: true, ws: true });
  proxy.upgrade(req, socket, head);
});
```

---

### Деплой на Render

1. Запушь оба файла в GitHub
2. Render → **New Web Service** → подключи репо
3. **Build:** `npm install` | **Start:** `node server.js`
4. Получишь URL вида `https://jackbox-proxy.onrender.com`

---

### Как настроить игры

**PP7 и новее** — параметр запуска Steam:
```
-jbg.config serverUrl=jackbox-proxy.onrender.com/ecast
