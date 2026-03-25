#!/usr/bin/env node
/**
 * ClaudeClaw Telegram Bridge v3
 * Mecanismo: claude -p --continue --output-format json
 * Provider: MiniMax via ANTHROPIC_BASE_URL
 * Credenciales: ../.env (nunca en el repo)
 */
'use strict';

const https  = require('https');
const http   = require('http');
const { execSync, spawn } = require('child_process');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

// ============================================================
// CARGAR .env (sin dependencias externas)
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
      if (!process.env[key]) process.env[key] = val;  // env vars tienen prioridad
    });
}
loadEnv();

// ============================================================
// CONFIG
// ============================================================
const TG_TOKEN    = process.env.TG_TOKEN;
const TG_API      = `https://api.telegram.org/bot${TG_TOKEN}`;
const ALLOWED_ID  = process.env.ALLOWED_ID;
const OPENAI_KEY  = process.env.OPENAI_KEY;
const MINIMAX_URL = process.env.ANTHROPIC_BASE_URL;
const MINIMAX_KEY = process.env.ANTHROPIC_AUTH_TOKEN;

if (!TG_TOKEN || !ALLOWED_ID || !MINIMAX_KEY) {
  console.error('❌ Faltan variables en .env — revisa ../.env');
  process.exit(1);
}

const WORK_DIR    = path.join(os.homedir(), '0Proyectos', 'ClaudeClaw');
const OFFSET_FILE = path.join(__dirname, '.telegram-offset');

// ============================================================
// TELEGRAM HELPERS
// ============================================================

function tgRequest(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url  = new URL(`${TG_API}/${method}`);
    const req  = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendMsg(chatId, text, replyTo) {
  // Telegram max = 4096 chars per message
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  return chunks.reduce((p, chunk, idx) =>
    p.then(() => tgRequest('sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'Markdown',
      ...(idx === 0 && replyTo ? { reply_to_message_id: replyTo } : {})
    })),
    Promise.resolve()
  );
}

function sendTyping(chatId) {
  return tgRequest('sendChatAction', { chat_id: chatId, action: 'typing' });
}

function sendFile(filePath, chatId) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return resolve({ ok: false });
    const ext  = path.extname(filePath).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
                   '.pdf': 'application/pdf', '.mp3': 'audio/mpeg' }[ext] || 'application/octet-stream';
    const isImg = ['.png','.jpg','.jpeg','.gif'].includes(ext);
    const method = isImg ? 'sendPhoto' : 'sendDocument';
    const boundary = 'b' + Math.random().toString(36).slice(2);
    const fileData = fs.readFileSync(filePath);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n`),
      Buffer.from(String(chatId)),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${path.basename(filePath)}"\r\nContent-Type: ${mime}\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const url = new URL(`${TG_API}/${method}`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function loadOffset() {
  try { return parseInt(fs.readFileSync(OFFSET_FILE, 'utf8'), 10) || 0; } catch { return 0; }
}
function saveOffset(n) { fs.writeFileSync(OFFSET_FILE, String(n)); }

// ============================================================
// CLAUDE -p CORE
// ============================================================

function askClaude(message, opts = {}) {
  return new Promise((resolve, reject) => {
    // Mismo entorno que el alias `cm` (~/claude-minimax.sh)
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL:                   MINIMAX_URL,
      ANTHROPIC_AUTH_TOKEN:                 MINIMAX_KEY,
      ANTHROPIC_MODEL:                      'MiniMax-M2.7',
      ANTHROPIC_SMALL_FAST_MODEL:           'MiniMax-M2.7',
      ANTHROPIC_DEFAULT_SONNET_MODEL:       'MiniMax-M2.7',
      ANTHROPIC_DEFAULT_OPUS_MODEL:         'MiniMax-M2.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL:        'MiniMax-M2.7',
      API_TIMEOUT_MS:                       '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };

    const args = [
      '--print',
      '--continue',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ];

    const proc = spawn('claude', [...args, message], {
      env,
      cwd: opts.workDir || WORK_DIR,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Timeout (120s)'));
    }, 120_000);

    proc.on('close', code => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout.trim());
        // claude -p json schema: { result, session_id, cost_usd, duration_ms, ... }
        const text = data.result ?? data.message ?? stdout.trim();
        resolve(String(text).trim());
      } catch {
        // Fallback: return raw stdout if JSON parse fails
        const raw = stdout.trim() || stderr.trim() || `Exit ${code}`;
        resolve(raw);
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ============================================================
// VOICE → WHISPER → TEXTO
// ============================================================

async function transcribeVoice(fileId) {
  // 1. Get file path
  const info = await tgRequest('getFile', { file_id: fileId });
  if (!info.ok) throw new Error('getFile failed');

  const audioUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${info.result.file_path}`;
  const ogaPath  = path.join(os.tmpdir(), `vc-${Date.now()}.oga`);
  const mp3Path  = path.join(os.tmpdir(), `vc-${Date.now()}.mp3`);

  // 2. Download
  await new Promise((res, rej) => {
    https.get(audioUrl, r => {
      const s = fs.createWriteStream(ogaPath);
      r.pipe(s);
      s.on('finish', res);
      s.on('error', rej);
    }).on('error', rej);
  });

  // 3. Convert to mp3
  try { execSync(`ffmpeg -y -i "${ogaPath}" -vn -acodec libmp3lame -q:a 2 "${mp3Path}" 2>/dev/null`); }
  catch { fs.copyFileSync(ogaPath, mp3Path); }

  // 4. Whisper
  const fileContent = fs.readFileSync(mp3Path);
  const boundary    = 'w' + Math.random().toString(36).slice(2);
  const body        = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
    fileContent,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type':  `multipart/form-data; boundary=${boundary}`,
    },
    body
  });

  if (!whisperRes.ok) throw new Error(`Whisper ${whisperRes.status}`);
  const wData = await whisperRes.json();

  // Cleanup
  try { fs.unlinkSync(ogaPath); } catch {}
  try { fs.unlinkSync(mp3Path); } catch {}

  return (wData.text || '').trim();
}

// ============================================================
// COMMAND HANDLERS (slash commands locales, sin Claude)
// ============================================================

const CMD = {
  async ping()     { return `Pong! ${Date.now()}`; },
  async hora()     { return new Date().toLocaleTimeString('es-MX'); },
  async fecha()    { return new Date().toLocaleDateString('es-MX', { weekday:'long', year:'numeric', month:'long', day:'numeric' }); },
  async uptime()   { const s = process.uptime(); return `Uptime: ${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`; },

  async start()    { return `🤖 *ClaudeClaw Bridge v3*\n\nControla tu Mac desde Telegram.\n\n*Lenguaje natural* → Claude Code (MiniMax)\n*Nota de voz* → Whisper → Claude Code\n*/comando* → ejecución local\n\nUsa /help para ver todos los comandos.`; },

  async help() {
    return `📋 *Comandos locales (instantáneos):*
/ping /hora /fecha /uptime /status
/screenshot
/bash <cmd>
/read <path> — leer archivo
/list [dir] — listar directorio
/cpu /mem /disk /net
/open <app> /close <app>
/pbcopy <texto> /pbpaste
/screenshot

*Todo lo demás* → Claude Code con herramientas completas`;
  },

  async status() {
    return `📊 *Status*\n• Bridge: ✅ v3\n• Provider: MiniMax\n• Uptime: ${Math.floor(process.uptime()/60)}min`;
  },

  async screenshot(_, __, chatId) {
    const p = path.join(os.tmpdir(), `ss-${Date.now()}.png`);
    try {
      execSync(`screencapture -x "${p}"`);
      await sendFile(p, chatId);
      fs.unlinkSync(p);
      return null; // ya se envió el archivo
    } catch { return 'Error capturando pantalla'; }
  },

  async bash(_, args) {
    if (!args.length) return 'Uso: /bash <command>';
    const cmd = args.join(' ');
    try {
      const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
      return `\`\`\`\n${out.slice(0,3000)}\n\`\`\``;
    } catch (e) { return `Error: ${e.message.slice(0,500)}`; }
  },

  async read(_, args) {
    if (!args.length) return 'Uso: /read <path>';
    const p = args[0].replace(/^~/, os.homedir());
    try { return `\`\`\`\n${fs.readFileSync(p,'utf8').slice(0,3000)}\n\`\`\``; }
    catch { return 'Archivo no encontrado'; }
  },

  async list(_, args) {
    const dir = (args[0] || '~').replace(/^~/, os.homedir());
    try {
      const files = fs.readdirSync(dir).slice(0,60);
      return `📁 ${dir}\n\n${files.join('\n')}`;
    } catch { return 'Error listando directorio'; }
  },

  async cpu() {
    try { return `CPU: ${execSync('sysctl -n vm.loadavg', {encoding:'utf8'}).trim()}`; }
    catch { return 'Error'; }
  },

  async mem() {
    const mem = os.totalmem(), free = os.freemem();
    return `RAM: ${((mem-free)/1e9).toFixed(1)}GB usada / ${(mem/1e9).toFixed(1)}GB total`;
  },

  async disk() {
    try { return execSync('df -h /', {encoding:'utf8'}).trim().split('\n')[1]; }
    catch { return 'Error'; }
  },

  async net() {
    try {
      const out = execSync('ifconfig', {encoding:'utf8'});
      const active = out.split('\n\n').filter(s => s.includes('status: active'))
        .map(s => (s.match(/^(\w+):/) || [])[1]).filter(Boolean);
      return `🌐 Activas: ${active.join(', ') || 'ninguna'}`;
    } catch { return 'Error'; }
  },

  async open(_, args) {
    if (!args.length) return 'Uso: /open <app>';
    execSync(`open -a "${args.join(' ')}"`);
    return `✅ Abriendo ${args.join(' ')}`;
  },

  async close(_, args) {
    if (!args.length) return 'Uso: /close <app>';
    try { execSync(`pkill -f "${args.join(' ')}"`); return `✅ Cerrado`; }
    catch { return 'No encontrado'; }
  },

  async pbcopy(_, args) {
    if (!args.length) return 'Uso: /pbcopy <texto>';
    execSync(`printf '%s' ${JSON.stringify(args.join(' '))} | pbcopy`);
    return '✅ Copiado al clipboard';
  },

  async pbpaste() {
    return execSync('pbpaste', {encoding:'utf8'}).slice(0,2000) || '(vacío)';
  },
};

// ============================================================
// MESSAGE ROUTER
// ============================================================

async function handleMessage(msg) {
  const chatId  = String(msg.chat.id);
  const userId  = String(msg.from?.id || '');
  const replyTo = msg.message_id;
  const text    = msg.text || '';
  const isVoice = !!msg.voice;

  // Auth
  if (userId !== ALLOWED_ID) {
    await sendMsg(chatId, 'No autorizado.', replyTo);
    return;
  }

  // --- VOICE ---
  if (isVoice) {
    const typingLoop = startTyping(chatId);
    try {
      const transcript = await transcribeVoice(msg.voice.file_id);
      if (!transcript) { stopTyping(typingLoop); await sendMsg(chatId, '🎤 No pude transcribir el audio.', replyTo); return; }
      const response = await askClaude(transcript);
      stopTyping(typingLoop);
      await sendMsg(chatId, `🎤 _"${transcript}"_\n\n${response}`, replyTo);
    } catch (e) {
      stopTyping(typingLoop);
      await sendMsg(chatId, `Error procesando audio: ${e.message}`, replyTo);
    }
    return;
  }

  if (!text.trim()) return;

  // --- SLASH COMMANDS ---
  if (text.startsWith('/')) {
    const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase().split('@')[0]; // strip @botname
    const handler = CMD[cmd];

    if (handler) {
      try {
        const result = await handler(chatId, args, chatId, replyTo);
        if (result) await sendMsg(chatId, result, replyTo);
      } catch (e) {
        await sendMsg(chatId, `Error: ${e.message}`, replyTo);
      }
      return;
    }
    // Unknown slash → pass to Claude as-is
  }

  // --- NATURAL LANGUAGE / UNKNOWN COMMAND → CLAUDE CODE ---
  const typingLoop = startTyping(chatId);
  try {
    const response = await askClaude(text);
    stopTyping(typingLoop);
    await sendMsg(chatId, response || '(sin respuesta)', replyTo);
  } catch (e) {
    stopTyping(typingLoop);
    await sendMsg(chatId, `Error Claude: ${e.message}`, replyTo);
  }
}

// ============================================================
// TYPING INDICATOR LOOP
// ============================================================

function startTyping(chatId) {
  sendTyping(chatId);
  return setInterval(() => sendTyping(chatId), 4000);
}
function stopTyping(interval) {
  clearInterval(interval);
}

// ============================================================
// POLLING LOOP
// ============================================================

async function poll() {
  console.log('🚀 ClaudeClaw Bridge v3 iniciado');
  console.log(`   Provider: ${MINIMAX_URL}`);
  console.log(`   WorkDir:  ${WORK_DIR}`);

  while (true) {
    try {
      const offset  = loadOffset();
      const updates = await tgRequest('getUpdates', { offset, timeout: 30 });

      if (updates.ok && updates.result?.length) {
        for (const upd of updates.result) {
          if (upd.message && !upd.message.from?.is_bot) {
            handleMessage(upd.message).catch(e => console.error('handleMessage:', e.message));
          }
          saveOffset(upd.update_id + 1);
        }
      }
    } catch (e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

poll();
