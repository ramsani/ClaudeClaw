#!/usr/bin/env node
/**
 * ClaudeClaw Bridge v5
 * Arquitectura: API local pura — n8n maneja Telegram, este bridge ejecuta Claude
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
 *   → { "ok": true, "uptime": N }
 */
'use strict';

const http   = require('http');
const { execSync, spawn } = require('child_process');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

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
const OPENAI_KEY  = process.env.OPENAI_KEY;
const TG_TOKEN    = process.env.TG_TOKEN;
const MINIMAX_URL = process.env.ANTHROPIC_BASE_URL;
const MINIMAX_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
const API_PORT    = parseInt(process.env.BRIDGE_PORT || '5679', 10);
const WORK_DIR    = path.join(os.homedir(), '0Proyectos', 'MyClaw');

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
// PARSEAR STREAM-JSON Y EXTRAER TOOL CALLS
// ============================================================
function parseStreamJson(line, chatId, seenTools) {
  try {
    const event = JSON.parse(line);

    // Tool calls en mensajes del asistente
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && !seenTools.has(block.id)) {
          seenTools.add(block.id);
          const fn = TOOL_LABELS[block.name];
          const label = fn ? fn(block.input || {}) : `🔧 ${block.name}`;
          sendTelegramProgress(chatId, label);
        }
      }
    }

    if (event.type === 'result') return String(event.result || '').trim();
  } catch {}
  return null;
}

// ============================================================
// CLAUDE -p CORE con streaming de herramientas
// ============================================================
function askClaude(message, chatId) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '--print', '--continue',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      message,
    ], { env: CLAUDE_ENV, cwd: WORK_DIR });

    let buffer = '', result = '', stderr = '';
    const seenTools = new Set();

    proc.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const r = parseStreamJson(line, chatId, seenTools);
        if (r !== null) result = r;
      }
    });

    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('Timeout (120s)')); }, 120_000);

    proc.on('close', code => {
      clearTimeout(timer);
      // flush buffer
      if (buffer.trim()) {
        const r = parseStreamJson(buffer.trim(), chatId, seenTools);
        if (r !== null) result = r;
      }
      console.log(`claude exit=${code} result=${result.slice(0, 80)}`);
      resolve(result || stderr.trim() || `Exit ${code}`);
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ============================================================
// CLAUDE CON IMAGEN (vision via --input-format stream-json)
// ============================================================
function askClaudeWithImage(base64Data, mimeType, caption, chatId) {
  return new Promise((resolve, reject) => {
    const input = JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Data } },
          { type: 'text', text: caption || 'Analiza esta imagen.' },
        ],
      }],
    });

    const proc = spawn('claude', [
      '--print', '--continue',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ], { env: CLAUDE_ENV, cwd: WORK_DIR });

    proc.stdin.write(input);
    proc.stdin.end();

    let buffer = '', result = '', stderr = '';
    const seenTools = new Set();

    proc.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const r = parseStreamJson(line, chatId, seenTools);
        if (r !== null) result = r;
      }
    });

    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('Timeout (120s)')); }, 120_000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (buffer.trim()) {
        const r = parseStreamJson(buffer.trim(), chatId, seenTools);
        if (r !== null) result = r;
      }
      resolve(result || stderr.trim() || `Exit ${code}`);
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ============================================================
// DESCARGAR ARCHIVO DE TELEGRAM
// ============================================================
async function downloadTelegramFile(fileId) {
  if (!TG_TOKEN) throw new Error('TG_TOKEN no configurado');

  // 1. Obtener file_path
  const infoRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${fileId}`);
  if (!infoRes.ok) throw new Error(`getFile ${infoRes.status}`);
  const info = await infoRes.json();
  const filePath = info.result?.file_path;
  if (!filePath) throw new Error('file_path vacío');

  // 2. Descargar contenido
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
  if (!fileRes.ok) throw new Error(`download ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
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

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type':  `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

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
  status:     () => `Bridge v5 ✅\nProvider: MiniMax\nUptime: ${Math.floor(process.uptime()/60)}min`,

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
// ROUTER: texto → comando local o Claude
// ============================================================
async function route(message, chatId) {
  const text = (message || '').trim();
  if (!text) return '(mensaje vacío)';

  if (text.startsWith('/')) {
    const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase().split('@')[0];
    const handler = CMD[cmd];
    if (handler) {
      try { return handler(args) ?? '✅'; }
      catch (e) { return `Error: ${e.message}`; }
    }
  }

  return await askClaude(text, chatId);
}

// ============================================================
// HTTP API SERVER
// ============================================================
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
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
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    return jsonRes(res, 200, { ok: true, uptime: process.uptime(), provider: MINIMAX_URL });
  }

  // POST /execute  { message, chat_id? }
  if (req.method === 'POST' && req.url === '/execute') {
    try {
      const body = await readBody(req);
      const { message, chat_id } = JSON.parse(body.toString());
      if (!message) return jsonRes(res, 400, { error: 'message required' });
      console.log(`[execute] chat=${chat_id} msg=${String(message).slice(0, 80)}`);
      const result = await route(message, chat_id);
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
      const tmpPath = path.join(os.tmpdir(), `tg-file-${Date.now()}${ext}`);
      fs.writeFileSync(tmpPath, buffer);

      let result;

      if (IMAGE_MIMES.has(mime_type)) {
        // Imagen → visión directa
        const base64 = buffer.toString('base64');
        const safeMime = mime_type === 'image/jpg' ? 'image/jpeg' : mime_type;
        result = await askClaudeWithImage(base64, safeMime, caption || 'Analiza esta imagen.', chat_id);
      } else {
        // Archivo → Claude lo lee con sus herramientas
        const msg = caption
          ? `${caption}\n\n[Archivo disponible en: ${tmpPath}]`
          : `Tengo un archivo en: ${tmpPath}\nAnalízalo o úsalo según sea necesario.`;
        result = await askClaude(msg, chat_id);
      }

      try { fs.unlinkSync(tmpPath); } catch {}
      return jsonRes(res, 200, { result });
    } catch (e) {
      console.error('[execute-with-file] error:', e.message);
      return jsonRes(res, 500, { error: e.message });
    }
  }

  // POST /transcribe  (raw audio body, query: ?filename=audio.oga)
  if (req.method === 'POST' && req.url.startsWith('/transcribe')) {
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

  jsonRes(res, 404, { error: 'Not found' });
});

server.listen(API_PORT, '0.0.0.0', () => {
  console.log('🚀 ClaudeClaw Bridge v5 iniciado');
  console.log(`   API:      http://0.0.0.0:${API_PORT}`);
  console.log(`   Provider: ${MINIMAX_URL}`);
  console.log(`   WorkDir:  ${WORK_DIR}`);
  console.log('   Modo: stream-json + imágenes + archivos');
});
