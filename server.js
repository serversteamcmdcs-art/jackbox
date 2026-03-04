/**
 * JackboxAllVersions Server
 * Supports:
 *  - Ecast / API v2  → Party Pack 7, 8, 9, 10, Drawful 2 International, etc.
 *  - Blobcast / API v1 → Party Pack 1–6, Quiplash 2 InterLASHional, etc.
 *
 * Deploy on Render.com — no TLS config needed (Render handles it).
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { Server: SocketIOServer } = require('socket.io');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.ACCESSIBLE_HOST || 'localhost';

// ─── Shared State ──────────────────────────────────────────────────────────────
// rooms: Map<roomCode, roomObject>
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── ECAST (API v2) endpoints ────────────────────────────────────────────────
  // GET /api/v2/rooms/:code  — join/info
  const roomMatch = path.match(/^\/api\/v2\/rooms\/([A-Z]{4})$/i);
  if (req.method === 'GET' && roomMatch) {
    const code = roomMatch[1].toUpperCase();
    const room = rooms.get(code);
    if (!room || room.protocol !== 'ecast') {
      res.writeHead(404);
      res.end(JSON.stringify({ message: 'room not found' }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify(buildEcastRoomInfo(room)));
    return;
  }

  // POST /api/v2/rooms  — create room
  if (req.method === 'POST' && path === '/api/v2/rooms') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let parsed2 = {};
      try { parsed2 = JSON.parse(body); } catch (_) {}
      const code = generateRoomCode();
      const room = {
        code,
        protocol: 'ecast',
        appTag: parsed2.appTag || 'unknown',
        appId: parsed2.appId || generateId(),
        host: null,         // WebSocket of host
        clients: new Map(), // id -> { ws, name, blob }
        blob: {},           // game state blob
        locked: false,
        created: Date.now(),
      };
      rooms.set(code, room);
      console.log(`[ECAST] Room created: ${code} (${room.appTag})`);
      res.writeHead(200);
      res.end(JSON.stringify(buildEcastRoomInfo(room)));
    });
    return;
  }

  // ── BLOBCAST (API v1) endpoints ─────────────────────────────────────────────
  // GET /room/:code/  — join info (old games)
  const blobRoomMatch = path.match(/^\/room\/([A-Z]{4})\/?$/i);
  if (req.method === 'GET' && blobRoomMatch) {
    const code = blobRoomMatch[1].toUpperCase();
    const room = rooms.get(code);
    if (!room || room.protocol !== 'blobcast') {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, message: 'room not found' }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify(buildBlobcastRoomInfo(room)));
    return;
  }

  // POST /room  — create blobcast room
  if (req.method === 'POST' && path === '/room') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      let parsed2 = {};
      try { parsed2 = JSON.parse(body); } catch (_) {}
      const code = generateRoomCode();
      const room = {
        code,
        protocol: 'blobcast',
        appTag: parsed2.apptag || parsed2.appTag || 'unknown',
        host: null,
        clients: new Map(),
        blob: {},
        locked: false,
        created: Date.now(),
      };
      rooms.set(code, room);
      console.log(`[BLOBCAST] Room created: ${code} (${room.appTag})`);
      res.writeHead(200);
      res.end(JSON.stringify(buildBlobcastRoomInfo(room)));
    });
    return;
  }

  // ── Health check ─────────────────────────────────────────────────────────────
  if (path === '/health' || path === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      protocols: ['ecast-v2', 'blobcast-v1'],
    }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ message: 'not found' }));
});

// ─── Room Info Builders ────────────────────────────────────────────────────────
function buildEcastRoomInfo(room) {
  return {
    roomid: room.code,
    server: {
      name: room.appTag,
      connectionstring: `wss://${HOST}/ecast`,
    },
    blob: room.blob,
    locked: room.locked,
    full: room.clients.size >= 16,
    moderation: { commenting: false },
    appTag: room.appTag,
    appId: room.appId,
  };
}

function buildBlobcastRoomInfo(room) {
  return {
    success: true,
    room: {
      roomid: room.code,
      server: `wss://${HOST}/blobcast`,
      apptag: room.appTag,
      blob: JSON.stringify(room.blob),
      locked: room.locked,
    },
  };
}

// ─── ECAST WebSocket (/ecast) ──────────────────────────────────────────────────
const ecastWss = new WebSocketServer({ noServer: true });

ecastWss.on('connection', (ws, request) => {
  const query = url.parse(request.url, true).query;
  const role = query.role || 'player';        // 'host' or 'player'
  const roomCode = (query.roomid || '').toUpperCase();
  const clientId = generateId();

  const room = rooms.get(roomCode);
  if (!room || room.protocol !== 'ecast') {
    ws.close(4004, 'room not found');
    return;
  }

  console.log(`[ECAST] ${role} connected to ${roomCode} (id=${clientId})`);

  function sendTo(target, msg) {
    if (target && target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify(msg));
    }
  }

  function broadcast(msg, excludeWs) {
    room.clients.forEach(({ ws: cws }) => {
      if (cws !== excludeWs) sendTo(cws, msg);
    });
    if (room.host && room.host !== excludeWs) sendTo(room.host, msg);
  }

  if (role === 'host') {
    room.host = ws;
    sendTo(ws, { opcode: 'connected', roomid: roomCode });
  } else {
    const name = query.name || `Player_${clientId.slice(0, 4)}`;
    room.clients.set(clientId, { ws, name, blob: {} });

    sendTo(ws, { opcode: 'client/connected', id: clientId });

    // notify host
    sendTo(room.host, {
      opcode: 'client/connected',
      id: clientId,
      name,
      blob: {},
    });
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }

    const op = msg.opcode || msg.type;

    // Host → all clients
    if (role === 'host') {
      if (op === 'client/send' && msg.id) {
        const target = room.clients.get(msg.id);
        if (target) sendTo(target.ws, { opcode: 'server/send', body: msg.body });
      } else if (op === 'broadcast') {
        room.clients.forEach(({ ws: cws }) => {
          sendTo(cws, { opcode: 'server/send', body: msg.body });
        });
      } else if (op === 'room/update') {
        if (msg.blob) room.blob = { ...room.blob, ...msg.blob };
        if (typeof msg.locked === 'boolean') room.locked = msg.locked;
        broadcast({ opcode: 'room/update', blob: room.blob, locked: room.locked }, ws);
      }
    }

    // Client → host
    if (role === 'player') {
      if (op === 'client/send' || op === 'send') {
        sendTo(room.host, {
          opcode: 'client/send',
          id: clientId,
          body: msg.body,
        });
      } else if (op === 'client/update' && msg.blob) {
        const client = room.clients.get(clientId);
        if (client) client.blob = { ...client.blob, ...msg.blob };
        sendTo(room.host, {
          opcode: 'client/update',
          id: clientId,
          blob: room.clients.get(clientId)?.blob,
        });
      }
    }
  });

  ws.on('close', () => {
    if (role === 'host') {
      console.log(`[ECAST] Host left ${roomCode}, closing room`);
      room.clients.forEach(({ ws: cws }) => cws.close(1001, 'host left'));
      rooms.delete(roomCode);
    } else {
      room.clients.delete(clientId);
      console.log(`[ECAST] Player ${clientId} left ${roomCode}`);
      sendTo(room.host, { opcode: 'client/disconnected', id: clientId });
    }
  });

  ws.on('error', (err) => console.error(`[ECAST] WS error: ${err.message}`));
});

// ─── BLOBCAST Socket.IO (/blobcast) ────────────────────────────────────────────
// Old games (Pack 1–6) use Socket.IO v1/v2 (EIO=3)
const blobcastIO = new SocketIOServer(httpServer, {
  path: '/blobcast',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // allow old EIO=3 clients (socket.io v1/v2)
  allowEIO3: true,
  transports: ['websocket', 'polling'],
});

blobcastIO.on('connection', (socket) => {
  const query = socket.handshake.query;
  const role = query.role || 'player';
  const roomCode = (query.roomid || '').toUpperCase();
  const clientId = generateId();

  const room = rooms.get(roomCode);
  if (!room || room.protocol !== 'blobcast') {
    socket.emit('error', { message: 'room not found' });
    socket.disconnect(true);
    return;
  }

  console.log(`[BLOBCAST] ${role} connected to ${roomCode} (id=${clientId})`);

  function emitToHost(event, data) {
    if (room.hostSocketId) {
      blobcastIO.to(room.hostSocketId).emit(event, data);
    }
  }

  if (role === 'host') {
    room.hostSocketId = socket.id;
    socket.join(roomCode);
    socket.emit('connected', { roomid: roomCode });
  } else {
    const name = query.name || `Player_${clientId.slice(0, 4)}`;
    room.clients.set(clientId, { socketId: socket.id, name, blob: {} });
    socket.join(roomCode);

    socket.emit('client/connected', { id: clientId });
    emitToHost('client/connected', { id: clientId, name, blob: {} });
  }

  // Client → Host
  socket.on('send', (data) => {
    if (role === 'player') {
      emitToHost('client/send', { id: clientId, body: data });
    }
  });

  socket.on('client/send', (data) => {
    if (role === 'player') {
      emitToHost('client/send', { id: clientId, body: data });
    }
  });

  // Host → Client(s)
  socket.on('broadcast', (data) => {
    if (role === 'host') {
      room.clients.forEach(({ socketId }) => {
        blobcastIO.to(socketId).emit('server/send', data);
      });
    }
  });

  socket.on('client/send', (data) => {
    if (role === 'host' && data.id) {
      const client = room.clients.get(data.id);
      if (client) {
        blobcastIO.to(client.socketId).emit('server/send', data.body);
      }
    }
  });

  socket.on('room/update', (data) => {
    if (role === 'host') {
      if (data.blob) room.blob = { ...room.blob, ...data.blob };
      if (typeof data.locked === 'boolean') room.locked = data.locked;
      socket.to(roomCode).emit('room/update', { blob: room.blob, locked: room.locked });
    }
  });

  // Blob update from client
  socket.on('client/update', (data) => {
    if (role === 'player') {
      const client = room.clients.get(clientId);
      if (client && data.blob) {
        client.blob = { ...client.blob, ...data.blob };
        emitToHost('client/update', { id: clientId, blob: client.blob });
      }
    }
  });

  socket.on('disconnect', () => {
    if (role === 'host') {
      console.log(`[BLOBCAST] Host left ${roomCode}, closing room`);
      blobcastIO.to(roomCode).emit('disconnect', { reason: 'host left' });
      rooms.delete(roomCode);
    } else {
      room.clients.delete(clientId);
      console.log(`[BLOBCAST] Player ${clientId} left ${roomCode}`);
      emitToHost('client/disconnected', { id: clientId });
    }
  });
});

// ─── HTTP Upgrade → route to correct WSS ──────────────────────────────────────
httpServer.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;

  if (pathname === '/ecast' || pathname.startsWith('/ecast?')) {
    ecastWss.handleUpgrade(request, socket, head, (ws) => {
      ecastWss.emit('connection', ws, request);
    });
  }
  // /blobcast is handled by socket.io internally via httpServer
});

// ─── Cleanup stale rooms every 30 min ─────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (now - room.created > 30 * 60 * 1000) {
      console.log(`[CLEANUP] Removing stale room ${code}`);
      rooms.delete(code);
    }
  });
}, 5 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n✅ Jackbox All-Versions Server running on port ${PORT}`);
  console.log(`   Host:       ${HOST}`);
  console.log(`   Ecast WS:   wss://${HOST}/ecast`);
  console.log(`   Blobcast:   wss://${HOST}/blobcast`);
  console.log(`   API v2:     https://${HOST}/api/v2/rooms`);
  console.log(`   API v1:     https://${HOST}/room\n`);
});
