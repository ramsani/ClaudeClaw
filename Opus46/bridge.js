#!/usr/bin/env node
/**
 * ClaudeClaw Bridge v3
 * Arquitectura: cola serializada + sesión persistente + historial SQLite
 *
 * POST http://localhost:5679/execute           { "message": "texto", "chat_id": "..." }
 *   → { "result": "..." }
 *
 * POST http://localhost:5679/execute-with-file { "file_id": "...", "caption": "...", "chat_id": "...", "mime_type": "..." }
 *   → { "result": "..." }
 *
 * POST http://localhost:5679/transcribe        (multipart: archivo de audio)
 *   → { "text": "transcripción" }
 *
 * GET  http://localhost:5679/health
 *   → { "ok": true, "uptime": N, "queue": {...} }
 *
 * GET  http://localhost:5679/api/history?limit=50&before=<unix_ms>&q=<search>&starred=1
 *   → [ { id, uuid, channel, role, content, ... } ]
 *
 * GET  http://localhost:5679/api/queue
 *   → { busy, size, maxSize }
 */
'use strict';

const http   = require('http');
const { execSync, spawn } = require('child_process');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ============================================================
// CARGAR .env
// ============================================================
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .forEach(l => {
      const eq = l.indexOf('=');
      if (eq < 0) return;
      const key = l.slice(0, eq).trim();
      const val = l.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    });
}
loadEnv();

// ============================================================
// MÓDULOS V3
// ============================================================
const db           = require('./lib/pgdb');   // PostgreSQL compartido con Nova
const session      = require('./lib/session');
const MessageQueue = require('./lib/queue');   // clase, no singleton
const auth         = require('./lib/auth');
const ws           = require('./lib/ws');
const files        = require('./lib/files');

// Init async — PostgreSQL necesita conectarse antes de servir
let pgReady = false;
const pgInitPromise = db.init().then(() => { pgReady = true; }).catch(e => {
  console.error('[bridge] PostgreSQL init falló:', e.message);
  console.warn('[bridge] Continuando sin DB — mensajes no se guardarán');
});

// ============================================================
// SINGLE INSTANCE LOCK
// ============================================================
const LOCK_FILE = '/tmp/claudeclaw-bridge.lock';
(function enforceSingleInstance() {
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try { process.kill(oldPid, 'SIGTERM'); console.log(`Killed old instance PID ${oldPid}`); }
      catch {}
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(LOCK_FILE); } catch {} process.exit(); };
  process.on('exit',    () => { try { fs.unlinkSync(LOCK_FILE); } catch {} });
  process.on('SIGINT',  cleanup);
  process.on('SIGTERM', cleanup);
})();

// ============================================================
// CONFIG
// ============================================================
const OPENAI_KEY    = process.env.OPENAI_KEY;
const TG_TOKEN      = process.env.TG_TOKEN;
const MINIMAX_URL   = process.env.ANTHROPIC_BASE_URL;
const MINIMAX_KEY   = process.env.ANTHROPIC_AUTH_TOKEN;
const API_PORT      = parseInt(process.env.BRIDGE_PORT || '5679', 10);
const TIMEOUT_MS    = parseInt(process.env.CLAUDE_TIMEOUT_MS || '300000', 10);
const WORK_DIR      = process.env.WORK_DIR || path.join(os.homedir(), '0Proyectos', 'MyClaw');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_CLAUDE || '3', 10);

// ============================================================
// SEMÁFORO GLOBAL — máx N procesos claude simultáneos
// ============================================================
let _activeClaudes = 0;
function withSemaphore(fn) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (_activeClaudes < MAX_CONCURRENT) {
        _activeClaudes++;
        fn().then(r => { _activeClaudes--; resolve(r); },
                  e => { _activeClaudes--; reject(e); });
      } else {
        setTimeout(attempt, 250);
      }
    };
    attempt();
  });
}

// ============================================================
// WORKSPACE MANAGER
// ============================================================
const workspaces = {
  _map: new Map(), // id → { id, name, path, color, description, queue }

  async load() {
    let rows = [];
    try { rows = await db.getWorkspaces(); } catch {}
    for (const ws of rows) {
      if (!this._map.has(ws.id)) {
        this._map.set(ws.id, { ...ws, queue: new MessageQueue() });
      }
    }
    // Workspace default: MyClaw siempre existe
    if (!this._map.has('myclaw')) {
      const def = { id: 'myclaw', name: 'MyClaw', path: WORK_DIR, color: '#007AFF', description: 'Workspace principal', sort_order: 0 };
      try { await db.upsertWorkspace(def); } catch {}
      this._map.set('myclaw', { ...def, queue: new MessageQueue() });
    }
  },

  get(id) {
    return this._map.get(id) || this._map.get('myclaw');
  },

  all() {
    return Array.from(this._map.values()).map(({ queue: q, ...ws }) => ({
      ...ws,
      queue: q.status(),
      activeClaudes: _activeClaudes,
    }));
  },

  async add({ id, name, path: wsPath, color, description, user_id = 'admin' }) {
    // Validar path — debe existir y estar bajo home
    const resolved = path.resolve(wsPath);
    if (!resolved.startsWith(os.homedir())) throw Object.assign(new Error('path must be under home dir'), { code: 'invalid_path' });
    if (!fs.existsSync(resolved)) throw Object.assign(new Error('path does not exist'), { code: 'invalid_path' });
    const safeId = id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase().slice(0, 40);
    const ws = { id: safeId, name, path: resolved, color: color || '#007AFF', description: description || '', sort_order: this._map.size, user_id };
    await db.upsertWorkspace(ws);
    this._map.set(safeId, { ...ws, queue: new MessageQueue() });
    // Crear carpeta reports/ en MyClaw si no existe
    const reportsDir = path.join(WORK_DIR, 'reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    // Crear CLAUDE.md en el workspace si no existe
    const claudeMd = path.join(resolved, 'CLAUDE.md');
    if (!fs.existsSync(claudeMd)) {
      fs.writeFileSync(claudeMd,
        `# Workspace: ${name}\n\nAl completar cualquier tarea significativa, actualiza el archivo:\n${path.join(WORK_DIR, 'reports', safeId + '.md')}\n\nFormato del reporte:\n- **Qué hice:** breve descripción\n- **Estado:** en progreso / completado / bloqueado\n- **Próximos pasos:** ...\n`
      );
    }
    return ws;
  },

  async remove(id) {
    if (id === 'myclaw') throw new Error('no se puede eliminar el workspace por defecto');
    await db.deleteWorkspace(id);
    this._map.delete(id);
  },
};

if (!MINIMAX_KEY) {
  console.error('❌ Falta ANTHROPIC_AUTH_TOKEN en .env');
  process.exit(1);
}

const CLAUDE_ENV = {
  ...process.env,
  ANTHROPIC_BASE_URL:                       MINIMAX_URL,
  ANTHROPIC_AUTH_TOKEN:                     MINIMAX_KEY,
  ANTHROPIC_MODEL:                          'MiniMax-M2.7',
  ANTHROPIC_SMALL_FAST_MODEL:               'MiniMax-M2.7',
  ANTHROPIC_DEFAULT_SONNET_MODEL:           'MiniMax-M2.7',
  ANTHROPIC_DEFAULT_OPUS_MODEL:             'MiniMax-M2.7',
  ANTHROPIC_DEFAULT_HAIKU_MODEL:            'MiniMax-M2.7',
  API_TIMEOUT_MS:                           '3000000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

// ============================================================
// TELEGRAM PROGRESS (notificaciones intermedias)
// ============================================================
const TOOL_LABELS = {
  Read:        (i) => `📂 Leyendo: ${path.basename(i.file_path || i.path || '')}`,
  Write:       (i) => `📝 Escribiendo: ${path.basename(i.file_path || i.path || '')}`,
  Edit:        (i) => `✏️ Editando: ${path.basename(i.file_path || i.path || '')}`,
  MultiEdit:   (i) => `✏️ Editando: ${path.basename(i.file_path || i.path || '')}`,
  Bash:        (i) => `⚡ ${String(i.command || i.cmd || '').slice(0, 80)}`,
  Glob:        (i) => `🗂️ Buscando archivos: ${i.pattern || ''}`,
  Grep:        (i) => `🔎 Buscando: ${String(i.pattern || '').slice(0, 60)}`,
  WebSearch:   (i) => `🌐 Buscando: ${String(i.query || '').slice(0, 60)}`,
  WebFetch:    (i) => `🌐 Descargando: ${String(i.url || '').slice(0, 60)}`,
  TodoWrite:   ()  => `📋 Actualizando tareas`,
  NotebookRead:(i) => `📓 Leyendo notebook: ${path.basename(i.notebook_path || '')}`,
};

async function sendTelegramProgress(chatId, text) {
  if (!chatId || !TG_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: true }),
    });
  } catch {}
}

// ============================================================
// PARSEAR STREAM-JSON — extrae tools, resultado y session_id
// ============================================================
function parseStreamJson(line, chatId, seenTools, sessionRef, messageUuid) {
  try {
    const event = JSON.parse(line);

    // Capturar session_id desde evento system.init
    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      if (sessionRef && !sessionRef.id) sessionRef.id = event.session_id;
    }

    // Capturar session_id desde evento result
    if (event.type === 'result' && event.session_id) {
      if (sessionRef && !sessionRef.id) sessionRef.id = event.session_id;
    }

    // Tool calls en mensajes del asistente
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && !seenTools.has(block.id)) {
          seenTools.add(block.id);
          const fn = TOOL_LABELS[block.name];
          const label = fn ? fn(block.input || {}) : `🔧 ${block.name}`;
          sendTelegramProgress(chatId, label);
          // Broadcast thinking event a PWA
          ws.broadcast({ type: 'thinking', tool: block.name, label, message_uuid: messageUuid });
        }
      }
    }

    if (event.type === 'result') return String(event.result || '').trim();
  } catch {}
  return null;
}

// ============================================================
// CLAUDE CORE — con sesión persistente y captura de session_id
// ============================================================
function _spawnClaude(args, chatId, channel, messageUuid, wsId, wsPath) {
  return withSemaphore(() => new Promise((resolve, reject) => {
    const cwd = wsPath || WORK_DIR;
    const proc = spawn('claude', args, { env: CLAUDE_ENV, cwd });

    sendTelegramProgress(chatId, '⚡ Claude arrancó');
    ws.broadcast({ type: 'typing', active: true, channel: channel || 'telegram', chat_id: chatId });

    let buffer = '', result = '', stderr = '';
    const seenTools = new Set();
    const sessionRef = { id: null };
    let sessionNotFound = false;

    proc.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const r = parseStreamJson(line, chatId, seenTools, sessionRef, messageUuid);
        if (r !== null) result = r;
      }
    });

    proc.stderr.on('data', d => {
      const txt = d.toString();
      stderr += txt;
      if (/session.not.found|No session|invalid.session|Session.*not.*found|No conversation found/i.test(txt)) {
        sessionNotFound = true;
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(Object.assign(new Error(`timeout after ${TIMEOUT_MS}ms`), { code: 'timeout' }));
    }, TIMEOUT_MS);

    proc.on('close', code => {
      clearTimeout(timer);
      if (buffer.trim()) {
        const r = parseStreamJson(buffer.trim(), chatId, seenTools, sessionRef, messageUuid);
        if (r !== null) result = r;
      }

      // Guardar session_id si lo capturamos (por workspace)
      if (sessionRef.id) {
        session.saveSession(sessionRef.id, wsId || 'myclaw');
        console.log(`[session] guardado ${sessionRef.id} ws=${wsId || 'myclaw'}`);
      }

      ws.broadcast({ type: 'typing', active: false });
      console.log(`claude exit=${code} result=${result.slice(0, 80)}`);

      if (sessionNotFound) {
        reject(Object.assign(new Error('session_not_found'), { code: 'session_not_found' }));
        return;
      }

      resolve({ result: result || stderr.trim() || `Exit ${code}`, sessionId: sessionRef.id });
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  }));
}

// Derivar clave de proyectos de Claude desde el path del workspace
// /Users/papa/0Proyectos/Nova → -Users-papa-0Proyectos-Nova
function claudeProjectsKey(wsPath) {
  return wsPath.replace(/\//g, '-');
}

// Construir args para claude según si tenemos sesión guardada
function buildClaudeArgs(message, uuid, wsPath) {
  const base = [
    '--print', '--verbose',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ];

  if (uuid) {
    const key = claudeProjectsKey(wsPath || WORK_DIR);
    const sessionFile = path.join(os.homedir(), '.claude', 'projects', key, `${uuid}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      return ['--resume', uuid, ...base, message];
    }
    console.warn(`[session] UUID ${uuid} sin archivo local (ws=${key}), usando --continue`);
  }
  return [...base, '--continue', message];
}

// askClaude con retry automático si session_not_found — workspace-aware
async function askClaude(message, chatId, channel, messageUuid, workspace) {
  const wsId   = workspace?.id   || 'myclaw';
  const wsPath = workspace?.path || WORK_DIR;
  const uuid   = await session.loadSession(wsId);

  try {
    const { result } = await _spawnClaude(buildClaudeArgs(message, uuid, wsPath), chatId, channel, messageUuid, wsId, wsPath);
    return result;
  } catch (err) {
    if (err.code === 'session_not_found' && uuid) {
      console.warn(`[bridge] session no encontrada ws=${wsId}, limpiando y reintentando`);
      await session.clearSession(wsId);
      const { result } = await _spawnClaude(buildClaudeArgs(message, null, wsPath), chatId, channel, messageUuid, wsId, wsPath);
      return result;
    }
    throw err;
  }
}

// ============================================================
// CLAUDE CON IMAGEN (vision via --input-format stream-json)
// ============================================================
async function askClaudeWithImage(base64Data, mimeType, caption, chatId, workspace) {
  const wsId   = workspace?.id   || 'myclaw';
  const wsPath = workspace?.path || WORK_DIR;
  const uuid   = await session.loadSession(wsId);
  return withSemaphore(() => new Promise((resolve, reject) => {
    const input = JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
          { type: 'text', text: caption || 'Analiza esta imagen.' },
        ],
      }],
    });

    const args = [
      '--print',
      ...(uuid ? ['--resume', uuid] : ['--continue']),
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ];

    const proc = spawn('claude', args, { env: CLAUDE_ENV, cwd: wsPath });

    proc.stdin.write(input);
    proc.stdin.end();

    let buffer = '', result = '', stderr = '';
    const seenTools = new Set();
    const sessionRef = { id: null };

    proc.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const r = parseStreamJson(line, chatId, seenTools, sessionRef);
        if (r !== null) result = r;
      }
    });

    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error(`timeout after ${TIMEOUT_MS}ms`)); }, TIMEOUT_MS);

    proc.on('close', code => {
      clearTimeout(timer);
      if (buffer.trim()) {
        const r = parseStreamJson(buffer.trim(), chatId, seenTools, sessionRef);
        if (r !== null) result = r;
      }
      if (sessionRef.id) session.saveSession(sessionRef.id, wsId);
      resolve(result || stderr.trim() || `Exit ${code}`);
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  }));
}

// ============================================================
// DESCARGAR ARCHIVO DE TELEGRAM
// ============================================================
async function downloadTelegramFile(fileId) {
  if (!TG_TOKEN) throw new Error('TG_TOKEN no configurado');

  const infoRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`);
  if (!infoRes.ok) throw new Error(`getFile ${infoRes.status}`);
  const info = await infoRes.json();
  const filePath = info.result?.file_path;
  if (!filePath) throw new Error('file_path vacío');

  const fileRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
  if (!fileRes.ok) throw new Error(`download ${fileRes.status}`);
  const contentLength = parseInt(fileRes.headers.get('content-length') || '0', 10);
  if (contentLength > 20 * 1024 * 1024) throw new Error('file_too_large');
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  if (buffer.length > 20 * 1024 * 1024) throw new Error('file_too_large');
  return { buffer, filePath };
}

// ============================================================
// WHISPER TRANSCRIPCIÓN
// ============================================================
async function transcribeBuffer(audioBuffer, filename) {
  const boundary = 'w' + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/ogg\r\n\r\n`),
    audioBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const controller = new AbortController();
  const whisperTimer = setTimeout(() => controller.abort(), 60_000);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type':  `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(whisperTimer);
  }

  if (!res.ok) throw new Error(`Whisper ${res.status}`);
  const data = await res.json();
  return (data.text || '').trim();
}

// ============================================================
// COMMAND HANDLERS (slash commands locales)
// ============================================================
const CMD = {
  ping:       () => `Pong! ${Date.now()}`,
  hora:       () => new Date().toLocaleTimeString('es-MX'),
  fecha:      () => new Date().toLocaleDateString('es-MX', { weekday:'long', year:'numeric', month:'long', day:'numeric' }),
  uptime:     () => { const s = process.uptime(); return `Uptime: ${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`; },
  status:     () => {
    const wsList = workspaces.all().map(w => `  ${w.name}: ${w.queue.busy ? 'pensando' : 'idle'} (cola: ${w.queue.size})`).join('\n');
    return `Bridge v3 ✅\nProvider: MiniMax\nUptime: ${Math.floor(process.uptime()/60)}min\nClaudes activos: ${_activeClaudes}/${MAX_CONCURRENT}\nWorkspaces:\n${wsList}`;
  },

  screenshot: () => {
    const p = path.join(os.tmpdir(), `ss-${Date.now()}.png`);
    execSync(`screencapture -x "${p}"`);
    const data = fs.readFileSync(p).toString('base64');
    try { fs.unlinkSync(p); } catch {}
    return { type: 'image', base64: data, mime: 'image/png' };
  },

  bash: (args) => {
    if (!args.length) return 'Uso: /bash <command>';
    try { return execSync(args.join(' '), { encoding: 'utf8', timeout: 30000 }).slice(0, 3000); }
    catch (e) { return `Error: ${e.message.slice(0, 500)}`; }
  },

  read: (args) => {
    if (!args.length) return 'Uso: /read <path>';
    const p = args[0].replace(/^~/, os.homedir());
    try { return fs.readFileSync(p, 'utf8').slice(0, 3000); }
    catch { return 'Archivo no encontrado'; }
  },

  list: (args) => {
    const dir = (args[0] || '~').replace(/^~/, os.homedir());
    try { return fs.readdirSync(dir).slice(0, 60).join('\n'); }
    catch { return 'Error listando directorio'; }
  },

  mem:  () => { const m = os.totalmem(), f = os.freemem(); return `RAM: ${((m-f)/1e9).toFixed(1)}GB usada / ${(m/1e9).toFixed(1)}GB total`; },
  disk: () => { try { return execSync('df -h /', {encoding:'utf8'}).trim().split('\n')[1]; } catch { return 'Error'; } },

  open: (args) => { execSync(`open -a "${args.join(' ')}"`); return `✅ Abriendo ${args.join(' ')}`; },
  pbpaste: () => execSync('pbpaste', {encoding:'utf8'}).slice(0, 2000) || '(vacío)',
  pbcopy:  (args) => { execSync(`printf '%s' ${JSON.stringify(args.join(' '))} | pbcopy`); return '✅ Copiado'; },
};

// ============================================================
// ROUTER: texto → comando local o Claude (via cola del workspace)
// ============================================================
async function route(message, chatId, channel = 'telegram', workspaceId = 'myclaw') {
  const text = (message || '').trim();
  if (!text) return '(mensaje vacío)';

  const workspace = workspaces.get(workspaceId);

  // Comandos locales no pasan por la cola
  if (text.startsWith('/')) {
    const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase().split('@')[0];
    const handler = CMD[cmd];
    if (handler) {
      try { return handler(args) ?? '✅'; }
      catch (e) { return `Error: ${e.message}`; }
    }
  }

  // Guardar mensaje del usuario en PostgreSQL + broadcast WS
  const userUuid = crypto.randomUUID();
  const now = Date.now();
  const wsId = workspace.id;
  const currentSession = await session.loadSession(wsId);
  db.insertMessage({
    uuid: userUuid, channel, role: 'user', content: text,
    chat_id: chatId ? String(chatId) : null,
    session_uuid: currentSession, file_path: null,
    workspace_id: wsId,
  }).catch(e => console.error('[db] insertMessage user error:', e.message));
  ws.broadcast({ type: 'message', role: 'user', content: text, uuid: userUuid, channel, created_at: now, workspace_id: wsId });

  // Encolar en la cola del workspace específico
  const assistantUuid = crypto.randomUUID();
  const result = await workspace.queue.push(() => askClaude(text, chatId, channel, assistantUuid, workspace));

  // Guardar respuesta del asistente en PostgreSQL + broadcast WS
  const assistantNow = Date.now();
  db.insertMessage({
    uuid: assistantUuid, channel, role: 'assistant', content: result,
    chat_id: chatId ? String(chatId) : null,
    session_uuid: currentSession, file_path: null,
    workspace_id: wsId,
  }).catch(e => console.error('[db] insertMessage assistant error:', e.message));
  ws.broadcast({ type: 'message', role: 'assistant', content: result, uuid: assistantUuid, channel, created_at: assistantNow, workspace_id: wsId });

  return result;
}

// ============================================================
// HTTP API SERVER
// ============================================================
const MAX_BODY = 16 * 1024 * 1024; // 16MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error('request_too_large'), { code: 'too_large' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonRes(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    res.end(); return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    return jsonRes(res, 200, {
      ok: true,
      uptime: process.uptime(),
      provider: MINIMAX_URL,
      workspaces: workspaces.all(),
      activeClaudes: _activeClaudes,
      maxConcurrent: MAX_CONCURRENT,
    });
  }

  // GET /api/queue  (compatibilidad hacia atrás — devuelve workspace por defecto)
  if (req.method === 'GET' && req.url === '/api/queue') {
    return jsonRes(res, 200, workspaces.get('myclaw').queue.status());
  }

  // GET /api/workspaces
  if (req.method === 'GET' && req.url === '/api/workspaces') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    const userId = auth.getSessionUser(req) || 'admin';
    const all = workspaces.all();
    // Filtrar por usuario: admin ve todos, otros solo los suyos
    const filtered = userId === 'admin' ? all : all.filter(ws => ws.user_id === userId || ws.user_id === 'admin');
    return jsonRes(res, 200, filtered);
  }

  // GET /api/workspaces/archived
  if (req.method === 'GET' && req.url === '/api/workspaces/archived') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const userId = auth.getSessionUser(req) || 'admin';
      const archived = await db.getArchivedWorkspaces(userId === 'admin' ? null : userId);
      return jsonRes(res, 200, archived);
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // POST /api/workspaces  { id, name, path, color?, description? }
  if (req.method === 'POST' && req.url === '/api/workspaces') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const data = JSON.parse(body.toString());
      if (!data.id || !data.name || !data.path) return jsonRes(res, 400, { error: 'id, name y path son requeridos' });
      const userId = auth.getSessionUser(req) || 'admin';
      const ws = await workspaces.add({ ...data, user_id: userId });
      return jsonRes(res, 201, { ok: true, workspace: ws });
    } catch (e) {
      return jsonRes(res, e.code === 'invalid_path' ? 400 : 500, { error: e.message });
    }
  }

  // DELETE /api/workspaces/:id
  if (req.method === 'DELETE' && req.url.startsWith('/api/workspaces/')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const wsId = req.url.split('/')[3];
      // Generar síntesis del tema a partir de los últimos mensajes antes de archivar
      try {
        const msgs = await db.getHistory({ workspace_id: wsId, limit: 6 });
        if (msgs.length > 0) {
          const preview = msgs
            .filter(m => m.role === 'user')
            .map(m => m.content.slice(0, 80))
            .slice(-2)
            .join(' / ');
          if (preview) {
            const ws = await db.getWorkspaces();
            const target = ws.find(w => w.id === wsId);
            if (target) {
              await db.upsertWorkspace({ ...target, description: preview });
            }
          }
        }
      } catch {}
      await workspaces.remove(wsId);
      return jsonRes(res, 200, { ok: true });
    } catch (e) {
      return jsonRes(res, 400, { error: e.message });
    }
  }

  // GET /api/history?limit=50&before=<unix_ms>&q=<search>&starred=1&workspace_id=myclaw
  if (req.method === 'GET' && req.url.startsWith('/api/history')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const params = new URL(req.url, 'http://x').searchParams;
      const limitRaw    = parseInt(params.get('limit') || '50', 10);
      const limit       = Math.min(Number.isFinite(limitRaw) ? limitRaw : 50, 200);
      const before      = params.get('before') ? parseInt(params.get('before'), 10) : null;
      const q           = params.get('q') || null;
      const starred     = params.get('starred') === '1';
      const workspace_id = params.get('workspace_id') || null;
      const sessionUser = auth.getSessionUser(req);
      // admin ve todo; usuarios normales ven solo sus mensajes
      const filterUserId = (sessionUser && sessionUser !== 'admin') ? sessionUser : null;
      const messages = await db.getHistory({ limit, before, q, starred, workspace_id, user_id: filterUserId });
      return jsonRes(res, 200, messages);
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // POST /execute  { message, chat_id? }
  if (req.method === 'POST' && req.url === '/execute') {
    try {
      const body = await readBody(req);
      const { message, chat_id } = JSON.parse(body.toString());
      if (!message) return jsonRes(res, 400, { error: 'message required' });
      console.log(`[execute] chat=${chat_id} msg=${String(message).slice(0, 80)}`);

      let result;
      try {
        result = await route(message, chat_id, 'telegram');
      } catch (e) {
        if (e.code === 'queue_full') return jsonRes(res, 503, { error: 'queue_full', queue: queue.status() });
        throw e;
      }
      return jsonRes(res, 200, { result });
    } catch (e) {
      console.error('[execute] error:', e.message);
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // POST /execute-with-file  { file_id, caption?, chat_id?, mime_type? }
  if (req.method === 'POST' && req.url === '/execute-with-file') {
    try {
      const body = await readBody(req);
      const { file_id, caption, chat_id, mime_type } = JSON.parse(body.toString());
      if (!file_id) return jsonRes(res, 400, { error: 'file_id required' });

      console.log(`[execute-with-file] file_id=${file_id} mime=${mime_type} chat=${chat_id}`);

      const { buffer, filePath } = await downloadTelegramFile(file_id);
      const ext = path.extname(filePath) || '.bin';
      const inboxDir = path.join(WORK_DIR, 'inbox');
      if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
      const savedPath = path.join(inboxDir, `tg-${Date.now()}${ext}`);
      fs.writeFileSync(savedPath, buffer);

      let result;
      let msg;
      if (mime_type === 'application/pdf') {
        try {
          const text = execSync(`pdftotext "${savedPath}" -`, { encoding: 'utf8', timeout: 15000 }).slice(0, 8000);
          msg = caption
            ? `${caption}\n\nArchivo guardado en: ${savedPath}\n\nContenido del PDF:\n${text}`
            : `Archivo guardado en: ${savedPath}\n\nContenido del PDF:\n${text}`;
        } catch {
          msg = caption
            ? `${caption}\n\n[PDF guardado en: ${savedPath}]`
            : `Tengo un PDF en: ${savedPath}\nAnalízalo.`;
        }
        try {
          result = await route(msg, chat_id, 'telegram');
        } catch (e) {
          if (e.code === 'queue_full') return jsonRes(res, 503, { error: 'queue_full', queue: queue.status() });
          throw e;
        }
      } else if (IMAGE_MIMES.has(mime_type)) {
        const base64Data = buffer.toString('base64');
        const fileUuid = crypto.randomUUID();
        db.insertMessage({
          uuid: fileUuid, channel: 'telegram', role: 'user',
          content: caption || '[imagen]',
          chat_id: chat_id ? String(chat_id) : null,
          session_uuid: null, file_path: savedPath,
        }).catch(() => {});
        try {
          result = await queue.push(() => askClaudeWithImage(base64Data, mime_type, caption, chat_id, workspaces.get('myclaw')));
        } catch (e) {
          if (e.code === 'queue_full') return jsonRes(res, 503, { error: 'queue_full', queue: queue.status() });
          throw e;
        }
        const assistantUuid = crypto.randomUUID();
        db.insertMessage({
          uuid: assistantUuid, channel: 'telegram', role: 'assistant',
          content: result, chat_id: chat_id ? String(chat_id) : null,
          session_uuid: null, file_path: null,
        }).catch(() => {});
      } else {
        msg = caption
          ? `${caption}\n\n[Archivo guardado en: ${savedPath}]`
          : `Tengo un archivo en: ${savedPath}\nAnalízalo o úsalo según sea necesario.`;
        try {
          result = await route(msg, chat_id, 'telegram');
        } catch (e) {
          if (e.code === 'queue_full') return jsonRes(res, 503, { error: 'queue_full', queue: queue.status() });
          throw e;
        }
      }

      return jsonRes(res, 200, { result });
    } catch (e) {
      console.error('[execute-with-file] error:', e.message);
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // POST /api/login  { password }
  if (req.method === 'POST' && req.url === '/api/login') {
    const body = await readBody(req);
    return auth.loginHandler(req, res, body);
  }

  // POST /api/chat  { message, chat_id?, workspace_id? }  — PWA mensajes (requiere auth)
  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const { message, chat_id, workspace_id } = JSON.parse(body.toString());
      if (!message) return jsonRes(res, 400, { error: 'message required' });
      const wsId = workspace_id || 'myclaw';
      console.log(`[api/chat] ws=${wsId} msg=${String(message).slice(0, 80)}`);
      let result;
      try {
        result = await route(message, chat_id || null, 'pwa', wsId);
      } catch (e) {
        if (e.code === 'queue_full') return jsonRes(res, 503, { error: 'queue_full', queue: workspaces.get(wsId).queue.status() });
        throw e;
      }
      return jsonRes(res, 200, { result });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // POST /api/desktop-event  { role, content }  — hook de Claude Code desktop
  if (req.method === 'POST' && req.url === '/api/desktop-event') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const { role, content } = JSON.parse(body.toString());
      if (!content) return jsonRes(res, 400, { error: 'content required' });
      const msgUuid = crypto.randomUUID();
      const now = Date.now();
      db.insertMessage({
        uuid: msgUuid, channel: 'desktop',
        role: role === 'user' ? 'user' : 'assistant',
        content: String(content), chat_id: null,
        session_uuid: null, file_path: null,
      }).catch(() => {});
      ws.broadcast({ type: 'message', role: role || 'assistant', content: String(content), uuid: msgUuid, channel: 'desktop', created_at: now });
      return jsonRes(res, 200, { ok: true, uuid: msgUuid });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // PUT /api/messages/:uuid/star  { starred: true|false }
  if (req.method === 'PUT' && /^\/api\/messages\/[^/]+\/star$/.test(req.url)) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const msgUuid = req.url.split('/')[3];
      const body = await readBody(req);
      const { starred } = JSON.parse(body.toString());
      await db.starMessage(msgUuid, !!starred);
      return jsonRes(res, 200, { ok: true });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // ── NOVA SHARED DATA ───────────────────────────────────────

  // POST /api/nova/note  { title, content, note_type? }
  if (req.method === 'POST' && req.url === '/api/nova/note') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const { title, content, note_type } = JSON.parse(body.toString());
      if (!content) return jsonRes(res, 400, { error: 'content required' });
      const userId = auth.getSessionUser(req);
      const note = await db.createNote({ user_id: userId || null, title, content, note_type });
      ws.broadcast({ type: 'nova_note', note });
      return jsonRes(res, 201, { ok: true, note });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // GET /api/nova/notes?limit=20
  if (req.method === 'GET' && req.url.startsWith('/api/nova/notes')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const userId = auth.getSessionUser(req);
      const url = new URL(req.url, 'http://x');
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const notes = await db.getNotes({ user_id: userId || null, limit });
      return jsonRes(res, 200, notes);
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // POST /api/nova/action  { title, content, action_type?, due_at? }
  if (req.method === 'POST' && req.url === '/api/nova/action') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const { title, content, action_type, due_at } = JSON.parse(body.toString());
      if (!title) return jsonRes(res, 400, { error: 'title required' });
      const userId = auth.getSessionUser(req);
      const action = await db.createAction({ user_id: userId || null, title, content, action_type, due_at });
      ws.broadcast({ type: 'nova_action', action });
      return jsonRes(res, 201, { ok: true, action });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // GET /api/nova/actions?status=active&limit=20
  if (req.method === 'GET' && req.url.startsWith('/api/nova/actions')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const userId = auth.getSessionUser(req);
      const url = new URL(req.url, 'http://x');
      const status = url.searchParams.get('status') || null;
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const actions = await db.getActions({ user_id: userId || null, status, limit });
      return jsonRes(res, 200, actions);
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // GET /api/nova/recent?limit=10  — últimas notas + acciones combinadas
  if (req.method === 'GET' && req.url.startsWith('/api/nova/recent')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const userId = auth.getSessionUser(req);
      const qLimit = Math.min(parseInt(new URL(req.url, 'http://x').searchParams.get('limit') || '10', 10), 50);
      const [notes, actions] = await Promise.all([
        db.getNotes({ user_id: userId || null, limit: qLimit }),
        db.getActions({ user_id: userId || null, limit: qLimit }),
      ]);
      const combined = [
        ...notes.map(n => ({ ...n, type: 'note' })),
        ...actions.map(a => ({ ...a, type: 'action' })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, qLimit);
      return jsonRes(res, 200, combined);
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // PATCH /api/nova/note/:id  { title, content }
  // PATCH /api/nova/action/:id  { title, content }
  const novaEditMatch = req.url.match(/^\/api\/nova\/(note|action)\/(\d+)$/);
  if (req.method === 'PATCH' && novaEditMatch) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const [, type, id] = novaEditMatch;
      const body = await readBody(req);
      const { title, content } = JSON.parse(body.toString());
      const updated = type === 'note'
        ? await db.updateNote({ id: parseInt(id, 10), title, content })
        : await db.updateAction({ id: parseInt(id, 10), title, content });
      if (!updated) return jsonRes(res, 404, { error: 'not_found' });
      return jsonRes(res, 200, { ok: true, updated });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // GET /api/files/ls?path=/Users/papa  — lista subdirectorios (para file picker)
  if (req.method === 'GET' && req.url.startsWith('/api/files/ls')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const rawPath = new URL(req.url, 'http://x').searchParams.get('path') || os.homedir();
      const targetPath = rawPath.startsWith('~')
        ? path.join(os.homedir(), rawPath.slice(1))
        : rawPath;
      if (!targetPath.startsWith(os.homedir())) {
        return jsonRes(res, 400, { error: 'path_outside_home' });
      }
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: path.join(targetPath, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return jsonRes(res, 200, { path: targetPath, dirs });
    } catch (e) {
      return jsonRes(res, 400, { error: e.code || e.message });
    }
  }

  // ── ADMIN: gestión de usuarios ─────────────────────────────

  // GET /api/admin/users — listar usuarios (solo admin)
  if (req.method === 'GET' && req.url === '/api/admin/users') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    const callerUserId = auth.getSessionUser(req) || 'admin';
    if (callerUserId !== 'admin') return jsonRes(res, 403, { error: 'forbidden' });
    try {
      const users = await db.listUsers();
      return jsonRes(res, 200, users);
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // POST /api/admin/users — crear/actualizar usuario (solo admin)
  if (req.method === 'POST' && req.url === '/api/admin/users') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    const callerUserId = auth.getSessionUser(req) || 'admin';
    if (callerUserId !== 'admin') return jsonRes(res, 403, { error: 'forbidden' });
    try {
      const body = await readBody(req);
      const { userId, password, displayName, telegramChatId } = JSON.parse(body.toString());
      if (!userId || !password) return jsonRes(res, 400, { error: 'userId y password son requeridos' });
      await db.createUser({ userId, password, displayName, telegramChatId });
      return jsonRes(res, 201, { ok: true, userId });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // POST /transcribe  (raw audio body, query: ?filename=audio.oga)
  if (req.method === 'POST' && req.url.startsWith('/transcribe')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const audioBuffer = await readBody(req);
      const filename = new URL(req.url, 'http://x').searchParams.get('filename') || 'audio.oga';
      console.log(`[transcribe] ${filename} ${audioBuffer.length} bytes`);
      const text = await transcribeBuffer(audioBuffer, filename);
      return jsonRes(res, 200, { text });
    } catch (e) {
      console.error('[transcribe] error:', e.message);
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // ── FILE HUB ENDPOINTS ─────────────────────────────────────

  // GET /api/files?dir=inbox
  if (req.method === 'GET' && req.url.startsWith('/api/files') && !req.url.startsWith('/api/files/')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const params = new URL(req.url, 'http://x').searchParams;
      const dir = params.get('dir') || '';
      const list = files.listDir(dir);
      return jsonRes(res, 200, list);
    } catch (e) {
      return jsonRes(res, e.code === 'path_traversal' ? 400 : 500, { error: e.message });
    }
  }

  // GET /api/files/content?path=...  — texto plano para preview
  if (req.method === 'GET' && req.url.startsWith('/api/files/content')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const p = new URL(req.url, 'http://x').searchParams.get('path') || '';
      const content = files.readFile(p);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(content);
    } catch (e) {
      return jsonRes(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/files/download?path=...  — descarga con Content-Disposition
  if (req.method === 'GET' && req.url.startsWith('/api/files/download')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const p = new URL(req.url, 'http://x').searchParams.get('path') || '';
      const fullPath = files.safePath(p);
      const stat = require('fs').statSync(fullPath);
      const mime = files.mimeType(fullPath);
      const name = require('path').basename(fullPath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Access-Control-Allow-Origin': '*',
      });
      require('fs').createReadStream(fullPath).pipe(res);
    } catch (e) {
      return jsonRes(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/files/inline?path=...  — preview inline (imágenes, PDF)
  if (req.method === 'GET' && req.url.startsWith('/api/files/inline')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const p = new URL(req.url, 'http://x').searchParams.get('path') || '';
      const fullPath = files.safePath(p);
      const stat = require('fs').statSync(fullPath);
      const mime = files.mimeType(fullPath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
      });
      require('fs').createReadStream(fullPath).pipe(res);
    } catch (e) {
      return jsonRes(res, 400, { error: e.message });
    }
    return;
  }

  // GET /api/files/share?path=...  — genera token temporal
  if (req.method === 'GET' && req.url.startsWith('/api/files/share')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const p = new URL(req.url, 'http://x').searchParams.get('path') || '';
      const token = files.createShareToken(p);
      return jsonRes(res, 200, { token, url: `/api/files/public/${token}` });
    } catch (e) {
      return jsonRes(res, 400, { error: e.message });
    }
  }

  // GET /api/files/public/:token  — acceso sin auth a archivo compartido
  if (req.method === 'GET' && req.url.startsWith('/api/files/public/')) {
    const token = req.url.split('/')[4];
    const fullPath = files.resolveShareToken(token);
    if (!fullPath) return jsonRes(res, 404, { error: 'token_expired_or_invalid' });
    try {
      const stat = require('fs').statSync(fullPath);
      const mime = files.mimeType(fullPath);
      const name = require('path').basename(fullPath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Content-Disposition': `inline; filename="${name}"`,
        'Access-Control-Allow-Origin': '*',
      });
      require('fs').createReadStream(fullPath).pipe(res);
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/files/move  { from, to }
  if (req.method === 'POST' && req.url === '/api/files/move') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const { from, to } = JSON.parse(body.toString());
      const newPath = files.moveFile(from, to);
      return jsonRes(res, 200, { ok: true, path: newPath });
    } catch (e) {
      return jsonRes(res, e.code === 'path_traversal' ? 400 : 500, { error: e.message });
    }
  }

  // POST /api/files/rename  { path, name }
  if (req.method === 'POST' && req.url === '/api/files/rename') {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const body = await readBody(req);
      const { path: p, name } = JSON.parse(body.toString());
      const newPath = files.renameFile(p, name);
      return jsonRes(res, 200, { ok: true, path: newPath });
    } catch (e) {
      return jsonRes(res, e.code === 'path_traversal' ? 400 : 500, { error: e.message });
    }
  }

  // DELETE /api/files?path=...
  if (req.method === 'DELETE' && req.url.startsWith('/api/files')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const p = new URL(req.url, 'http://x').searchParams.get('path') || '';
      files.deleteFile(p);
      return jsonRes(res, 200, { ok: true });
    } catch (e) {
      const clientErr = ['path_traversal', 'path_required', 'cannot_delete_root'].includes(e.code);
      return jsonRes(res, clientErr ? 400 : 500, { error: e.message });
    }
  }

  // POST /api/upload  — subir archivo (multipart/form-data o raw body)
  if (req.method === 'POST' && req.url.startsWith('/api/upload')) {
    if (!auth.verifyToken(req)) return jsonRes(res, 401, { error: 'unauthorized' });
    try {
      const params = new URL(req.url, 'http://x').searchParams;
      const transcribeOnly = params.get('transcribe_only') === '1';
      const rawBody = await readBody(req);
      const contentType = req.headers['content-type'] || '';

      let fileBuffer, filename;

      if (contentType.includes('multipart/form-data')) {
        // Parseo básico de multipart: extraer primer archivo
        const boundary = contentType.match(/boundary=([^\s;]+)/)?.[1];
        if (!boundary) return jsonRes(res, 400, { error: 'no boundary' });
        const raw = rawBody.toString('binary');
        const parts = raw.split('--' + boundary);
        let found = false;
        for (const part of parts) {
          const match = part.match(/Content-Disposition: form-data;[^\r\n]*name="file"[^\r\n]*(filename="([^"]+)")?/i);
          if (match) {
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd < 0) continue;
            filename = match[2] || `upload-${Date.now()}.bin`;
            const body = part.slice(headerEnd + 4, part.length - 2); // strip trailing \r\n
            fileBuffer = Buffer.from(body, 'binary');
            found = true;
            break;
          }
        }
        if (!found) return jsonRes(res, 400, { error: 'no file in multipart' });
      } else {
        // Raw body
        filename = params.get('filename') || `upload-${Date.now()}.bin`;
        fileBuffer = rawBody;
      }

      if (transcribeOnly) {
        const text = await transcribeBuffer(fileBuffer, filename);
        return jsonRes(res, 200, { text });
      }

      // Guardar en inbox
      const inboxDir = require('path').join(files.WORK_DIR, 'inbox');
      if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
      const ext = require('path').extname(filename) || '.bin';
      const savedName = `pwa-${Date.now()}${ext}`;
      const savedPath = require('path').join(inboxDir, savedName);
      fs.writeFileSync(savedPath, fileBuffer);
      const relPath = require('path').relative(files.WORK_DIR, savedPath);

      return jsonRes(res, 200, { ok: true, path: relPath, filename: savedName, size: fileBuffer.length });
    } catch (e) {
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // ── SERVIR ARCHIVOS ESTÁTICOS DE LA PWA ──────────────────────

  // Mapeo de rutas a archivos en public/
  const PUBLIC_DIR = require('path').join(__dirname, 'public');

  let staticPath = req.url.split('?')[0];
  if (staticPath === '/') staticPath = '/index.html';
  // Solo servir GET de archivos conocidos
  if (req.method === 'GET') {
    const fullStatic = require('path').join(PUBLIC_DIR, staticPath);
    // Verificar que el path esté dentro de public/
    if (fullStatic.startsWith(PUBLIC_DIR) && fs.existsSync(fullStatic) && require('fs').statSync(fullStatic).isFile()) {
      const mime = files.mimeType(fullStatic);
      const content = fs.readFileSync(fullStatic);
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache',
      });
      res.end(content);
      return;
    }

    // SPA fallback: servir index.html para rutas desconocidas (excepto /api/*)
    if (!staticPath.startsWith('/api/') && !staticPath.startsWith('/ws')) {
      const indexPath = require('path').join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(indexPath));
        return;
      }
    }
  }

  jsonRes(res, 404, { error: 'Not found' });
});

// Iniciar WebSocket server
ws.init(server);

server.listen(API_PORT, '0.0.0.0', async () => {
  await pgInitPromise;
  await workspaces.load();
  const uuid = await session.loadSession('myclaw').catch(() => null);
  console.log('ClaudeClaw Bridge v3 iniciado');
  console.log(`   API:        http://0.0.0.0:${API_PORT}`);
  console.log(`   Provider:   ${MINIMAX_URL}`);
  console.log(`   WorkDir:    ${WORK_DIR}`);
  console.log(`   Session:    ${uuid || '(nueva)'}`);
  console.log(`   Timeout:    ${TIMEOUT_MS / 1000}s`);
  console.log(`   WS:         ws://0.0.0.0:${API_PORT}/ws`);
  console.log(`   Concurrent: ${MAX_CONCURRENT} Claude(s) max`);
  console.log(`   Workspaces: ${workspaces.all().map(w => w.name).join(', ')}`);
});
