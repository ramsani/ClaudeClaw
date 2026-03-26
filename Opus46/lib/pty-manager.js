'use strict';

let nodePty;
try {
  nodePty = require('node-pty');
} catch(e) {
  console.warn('[pty] node-pty no disponible:', e.message);
}

// sessions: Map<id, { pty, shell, dataCallbacks, exitCallbacks, created }>
const sessions = new Map();

function isAvailable() {
  return !!nodePty;
}

function create(id, { shell = 'bash', cols = 120, rows = 30, cwd } = {}) {
  if (!nodePty) throw new Error('node-pty no disponible');
  if (sessions.has(id)) kill(id);

  const shellPath = shell === 'claude' ? 'claude' : (process.env.SHELL || '/bin/zsh');
  // claude PTY: arrancar con permisos sin prompt, en el directorio MyClaw
  const CLAUDE_CWD = process.env.WORK_DIR
    || require('path').join(process.env.HOME || '/tmp', '0Proyectos', 'MyClaw');
  const shellArgs = shell === 'claude'
    ? ['--dangerously-skip-permissions']
    : [];
  const shellCwd = shell === 'claude' ? CLAUDE_CWD : (cwd || process.env.HOME || '/tmp');

  const ptyProcess = nodePty.spawn(shellPath, shellArgs, {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd: shellCwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const session = {
    pty: ptyProcess,
    shell,
    dataCallbacks: new Set(),
    exitCallbacks: new Set(),
    created: Date.now(),
  };

  ptyProcess.onData(data => {
    for (const cb of session.dataCallbacks) {
      try { cb(data); } catch {}
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    for (const cb of session.exitCallbacks) {
      try { cb(exitCode); } catch {}
    }
    sessions.delete(id);
    console.log(`[pty] sesión ${id} (${shell}) terminó con código ${exitCode}`);
  });

  sessions.set(id, session);
  console.log(`[pty] sesión ${id} creada (${shell}, ${cols}x${rows})`);
  return session;
}

function write(id, data) {
  const s = sessions.get(id);
  if (s) s.pty.write(data);
}

function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (s) {
    try { s.pty.resize(cols, rows); } catch {}
  }
}

function kill(id) {
  const s = sessions.get(id);
  if (s) {
    try { s.pty.kill(); } catch {}
    sessions.delete(id);
    console.log(`[pty] sesión ${id} destruida`);
  }
}

function onData(id, cb) {
  const s = sessions.get(id);
  if (s) s.dataCallbacks.add(cb);
}

function offData(id, cb) {
  const s = sessions.get(id);
  if (s) s.dataCallbacks.delete(cb);
}

function onExit(id, cb) {
  const s = sessions.get(id);
  if (s) s.exitCallbacks.add(cb);
}

function has(id) {
  return sessions.has(id);
}

module.exports = { isAvailable, create, write, resize, kill, onData, offData, onExit, has };
