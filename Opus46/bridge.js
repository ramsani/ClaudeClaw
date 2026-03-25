#!/usr/bin/env node
/**
 * ClaudeClaw Bridge v4
 * Arquitectura: API local pura — n8n maneja Telegram, este bridge ejecuta Claude
 *
 * POST http://localhost:5679/execute  { "message": "texto" }
 *   → { "result": "respuesta de Claude o comando local" }
 *
 * POST http://localhost:5679/transcribe  (multipart: archivo de audio)
 *   → { "text": "transcripción" }
 *
 * GET  http://localhost:5679/health
 *   → { "ok": true, "uptime": N }
 */
'use strict';

const https  = require('https');
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
const MINIMAX_URL = process.env.ANTHROPIC_BASE_URL;
const MINIMAX_KEY = process.env.ANTHROPIC_AUTH_TOKEN;
const API_PORT    = parseInt(process.env.BRIDGE_PORT || '5679', 10);
const WORK_DIR    = path.join(os.homedir(), '0Proyectos', 'ClaudeClaw');

if (!MINIMAX_KEY) {
  console.error('❌ Falta ANTHROPIC_AUTH_TOKEN en .env');
  process.exit(1);
}

// ============================================================
// CLAUDE -p CORE  (mismo entorno que alias `cm`)
// ============================================================
function askClaude(message) {
  return new Promise((resolve, reject) => {
    const env = {
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

    const proc = spawn('claude', [
      '--print', '--continue',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      message,
    ], { env, cwd: WORK_DIR });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('Timeout (120s)')); }, 120_000);

    proc.on('close', code => {
      clearTimeout(timer);
      console.log(`claude exit=${code} stdout=${stdout.slice(0, 100)}`);
      try {
        const data = JSON.parse(stdout.trim());
        resolve(String(data.result ?? data.message ?? stdout).trim());
      } catch {
        resolve(stdout.trim() || stderr.trim() || `Exit ${code}`);
      }
    });

    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
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
  status:     () => `Bridge v4 ✅\nProvider: MiniMax\nUptime: ${Math.floor(process.uptime()/60)}min`,

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
async function route(message) {
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
    // Slash desconocido → Claude
  }

  return await askClaude(text);
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

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, uptime: process.uptime(), provider: MINIMAX_URL });
  }

  // POST /execute  { message: "..." }
  if (req.method === 'POST' && req.url === '/execute') {
    try {
      const body = await readBody(req);
      const { message } = JSON.parse(body.toString());
      if (!message) return json(res, 400, { error: 'message required' });
      console.log(`[execute] ${String(message).slice(0, 80)}`);
      const result = await route(message);
      return json(res, 200, { result });
    } catch (e) {
      console.error('[execute] error:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // POST /transcribe  (raw audio body, query: ?filename=audio.oga)
  if (req.method === 'POST' && req.url.startsWith('/transcribe')) {
    try {
      const audioBuffer = await readBody(req);
      const filename = new URL(req.url, 'http://x').searchParams.get('filename') || 'audio.oga';
      console.log(`[transcribe] ${filename} ${audioBuffer.length} bytes`);
      const text = await transcribeBuffer(audioBuffer, filename);
      return json(res, 200, { text });
    } catch (e) {
      console.error('[transcribe] error:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(API_PORT, '0.0.0.0', () => {
  console.log('🚀 ClaudeClaw Bridge v4 iniciado');
  console.log(`   API:      http://0.0.0.0:${API_PORT}`);
  console.log(`   Provider: ${MINIMAX_URL}`);
  console.log(`   WorkDir:  ${WORK_DIR}`);
  console.log('   Modo: API local — n8n maneja Telegram');
});
