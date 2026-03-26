'use strict';

const { WebSocketServer } = require('ws');
const { verifyToken }     = require('./auth');
const ptyMgr              = require('./pty-manager');

let wss = null;

// Clientes conectados al chat: Set<WebSocket>
const clients = new Set();

function init(httpServer) {
  wss = new WebSocketServer({ noServer: true });

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

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ws/terminal') {
      handleTerminal(ws, url);
    } else {
      handleChat(ws);
    }
  });

  // Heartbeat: ping a todos los clientes de chat cada 30s
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) { clients.delete(ws); continue; }
      try { ws.ping(); } catch { clients.delete(ws); }
    }
  }, 30_000);

  wss.on('close', () => clearInterval(heartbeat));
  console.log('[ws] servidor WebSocket listo en /ws');
  return wss;
}

// ── Chat handler (comportamiento original) ─────────────────────
function handleChat(ws) {
  clients.add(ws);
  console.log(`[ws] chat conectado (total: ${clients.size})`);

  safeSend(ws, { type: 'connected', clientCount: clients.size });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') safeSend(ws, { type: 'pong' });
    } catch {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] chat desconectado (total: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error('[ws] error chat:', err.message);
    clients.delete(ws);
  });
}

// ── Terminal PTY handler ───────────────────────────────────────
function handleTerminal(ws, url) {
  const shell  = url.searchParams.get('shell') || 'bash';
  const sessionId = `pty_${shell}_${Date.now()}`;

  if (!ptyMgr.isAvailable()) {
    safeSend(ws, { type: 'pty_error', error: 'node-pty no disponible en este servidor' });
    ws.close();
    return;
  }

  const cols = parseInt(url.searchParams.get('cols') || '120');
  const rows = parseInt(url.searchParams.get('rows') || '30');

  console.log(`[ws] terminal ${shell} conectada (${cols}x${rows})`);

  try {
    ptyMgr.create(sessionId, { shell, cols, rows });
  } catch(e) {
    safeSend(ws, { type: 'pty_error', error: e.message });
    ws.close();
    return;
  }

  // PTY → WebSocket (output del proceso al browser)
  const onData = (data) => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(data); } catch {}  // raw binary/string — xterm.js lo consume directo
    }
  };
  ptyMgr.onData(sessionId, onData);

  // PTY exit → notificar browser
  ptyMgr.onExit(sessionId, (code) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'pty_exit', code }));
        ws.close();
      } catch {}
    }
  });

  // WebSocket → PTY (input del browser al proceso)
  ws.on('message', (data) => {
    const str = data.toString();
    // Mensajes de control vienen como JSON: {"type":"resize","cols":N,"rows":N}
    if (str.startsWith('{')) {
      try {
        const msg = JSON.parse(str);
        if (msg.type === 'resize') ptyMgr.resize(sessionId, msg.cols, msg.rows);
        if (msg.type === 'kill')   { ptyMgr.kill(sessionId); ws.close(); }
        return;
      } catch {}
    }
    // Resto: input de teclado → PTY
    ptyMgr.write(sessionId, str);
  });

  ws.on('close', () => {
    ptyMgr.offData(sessionId, onData);
    ptyMgr.kill(sessionId);
    console.log(`[ws] terminal ${shell} desconectada`);
  });

  ws.on('error', (err) => {
    console.error('[ws] error terminal:', err.message);
    ptyMgr.kill(sessionId);
  });
}

// ── Helpers ───────────────────────────────────────────────────
function safeSend(ws, event) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(event)); } catch {}
  }
}

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

function clientCount() { return clients.size; }

module.exports = { init, broadcast, clientCount, safeSend };
