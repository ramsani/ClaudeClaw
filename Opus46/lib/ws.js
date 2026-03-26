'use strict';

const { WebSocketServer } = require('ws');
const { verifyToken, parseCookies } = require('./auth');

let wss = null;

// Clientes conectados: Set<WebSocket>
const clients = new Set();

function init(httpServer) {
  wss = new WebSocketServer({ noServer: true });

  // Manejar upgrade HTTP → WS con verificación de auth
  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }

    if (!verifyToken(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[ws] cliente conectado (total: ${clients.size})`);

    // Enviar estado inicial
    safeSend(ws, { type: 'connected', clientCount: clients.size });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') safeSend(ws, { type: 'pong' });
      } catch {}
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[ws] cliente desconectado (total: ${clients.size})`);
    });

    ws.on('error', (err) => {
      console.error('[ws] error:', err.message);
      clients.delete(ws);
    });
  });

  // Heartbeat: ping a todos los clientes cada 30s para detectar conexiones muertas
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) {
        clients.delete(ws);
        continue;
      }
      try { ws.ping(); } catch { clients.delete(ws); }
    }
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));

  console.log('[ws] servidor WebSocket listo en /ws');
  return wss;
}

function safeSend(ws, event) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(event)); } catch {}
  }
}

// Broadcast a todos los clientes conectados
function broadcast(event) {
  const msg = JSON.stringify(event);
  let count = 0;
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(msg); count++; } catch { clients.delete(ws); }
    } else {
      clients.delete(ws);
    }
  }
  return count;
}

function clientCount() {
  return clients.size;
}

module.exports = { init, broadcast, clientCount, safeSend };
