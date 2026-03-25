#!/usr/bin/env node
const https = require('https');
const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// Configuration
const TELEGRAM_BOT_TOKEN = '8507509309:AAGjHcxa4UNnPFxnvO0w5sliIXzU9Xonrjo';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const ALLOWED_USER_ID = '6106631957';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TMUX_SESSION = 'claude-telegram';
const OFFSET_FILE = path.join(__dirname, '.telegram-offset');
const WEBHOOK_SECRET = 'test-secret';
const WEBHOOK_PORT = 5679;

// Folder structure for ClaudeClaw
const CLAUDE_FOLDER = path.join(os.homedir(), 'ClaudeClaw');
const INBOX_FOLDER = path.join(CLAUDE_FOLDER, 'Inbox');
const ACTIVE_FOLDER = path.join(CLAUDE_FOLDER, 'Active');
const ARCHIVE_FOLDER = path.join(CLAUDE_FOLDER, 'Archive');
const HISTORY_FOLDER = path.join(CLAUDE_FOLDER, 'History');

// Rate limiting
const RATE_LIMIT = 30;
const RATE_WINDOW = 60000;
const rateLimitMap = new Map();

// Sensitive patterns requiring confirmation
const SENSITIVE_PATTERNS = [
  /rm\s+-rf/i, /drop\s+table/i, /sudo\s+/i,
  /chmod\s+777/i, /eval\s*\(/i, /exec\s*\(/i,
  /format\s+(drive|disk)/i, /shred\s+/i,
  /pkill\s+-9/i, /kill\s+-9/i
];

// Error messages
const ERROR_MESSAGES = {
  'TIMEOUT': '⏱️ El comando tardó demasiado. Intenta de nuevo.',
  'NOT_FOUND': '🔍 Archivo o app no encontrada.',
  'PERMISSION_DENIED': '🚫 Sin permisos. Verifica configuración.',
  'RATE_LIMIT': '⚡ Demasiados comandos. Espera un momento.',
  'INVALID_ARGS': '❓ Argumentos inválidos. Usa /help para ver uso.',
  'EXECUTION_ERROR': '❌ Error ejecutando el comando.',
  'NETWORK_ERROR': '🌐 Error de red. Reintentando...',
  'UNKNOWN': '❓ Error desconocido.'
};

function isSensitive(command) {
  return SENSITIVE_PATTERNS.some(p => p.test(command));
}

function handleError(command, error, chatId, replyTo) {
  const errorType = Object.keys(ERROR_MESSAGES).find(k =>
    error.message && error.message.toLowerCase().includes(k.toLowerCase())
  ) || 'UNKNOWN';
  const userMessage = ERROR_MESSAGES[errorType];
  console.error(`Command: ${command}, Error: ${error.message}`);
  return userMessage;
}

// Fast path commands (no need to send to Claude)
const FAST_COMMANDS = {
  'ping': async () => `Pong! ${Date.now()}`,
  'hora': async () => new Date().toLocaleTimeString('es-MX'),
  'fecha': async () => new Date().toLocaleDateString('es-MX'),
  'uptime': async () => `Uptime: ${Math.floor(process.uptime() / 60)} min`,
};

// Sleep helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================
// TELEGRAM HELPERS
// ============================================

function sendMessageToTelegram(chatId, text, replyTo) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', reply_to_message_id: replyTo });
    const url = new URL(`${TELEGRAM_API}/sendMessage`);
    const options = {
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendFileToTelegram(filePath, chatId) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      resolve({ success: false, error: 'File not found' });
      return;
    }

    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.txt': 'text/plain',
      '.json': 'application/json', '.zip': 'application/zip',
      '.mp4': 'video/mp4', '.mp3': 'audio/mpeg'
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    const isImage = ['.png', '.jpg', '.jpeg', '.gif'].includes(ext);
    const method = isImage ? 'sendPhoto' : 'sendDocument';

    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const fileContent = fs.readFileSync(filePath);

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="chat_id"\r\n\r\n`),
      Buffer.from(chatId),
      Buffer.from(`\r\n--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="document"; filename="${fileName}"\r\n`),
      Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`),
      fileContent,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const url = new URL(`${TELEGRAM_API}/${method}`);
    const options = {
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function telegramRequest(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const url = new URL(`${TELEGRAM_API}/${method}`);
    const options = {
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function saveOffset(offset) { fs.writeFileSync(OFFSET_FILE, offset.toString()); }
function loadOffset() {
  try { return parseInt(fs.readFileSync(OFFSET_FILE, 'utf8'), 10) || 0; }
  catch { return 0; }
}

// ============================================
// COMMAND HANDLERS
// ============================================

const Handlers = {
  // System commands
  async ping(chatId, replyTo) {
    return `Pong! 🏓`;
  },

  async hora(chatId, replyTo) {
    return new Date().toLocaleTimeString('es-MX');
  },

  async fecha(chatId, replyTo) {
    return new Date().toLocaleDateString('es-MX', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  },

  async start(chatId, replyTo) {
    return `🤖 *Claude Telegram Bridge*

Controla tu Mac Mini desde Telegram.

*Comandos:*
• /help - Lista de comandos
• /status - Estado del sistema
• /screenshot - Captura pantalla
• /ping - Latencia

*Lenguaje natural:* Tambien puedes escribir en español!`;
  },

  async help(chatId, replyTo) {
    return `📋 *Comandos Disponibles*

*Sistema:* /ping, /status, /uptime, /logs, /restart, /network
*Pantalla:* /screenshot, /displays
*Computer:* /click, /move, /type, /press, /shortcut ⚠️ (requiere permisos Accessibility)
*Archivos:* /read, /write, /delete, /copy, /move, /list
*Bash:* /bash <cmd>, /shell <cmd>
*Apps:* /open <app>, /close <app>, /listapps
*Clipboard:* /copy <text>, /paste
*Tareas:* /inbox, /active, /archive, /newtask, /completetask
*Queue:* /freeze, /resume, /async, /queue, /cancel, /clear
*Buscar:* /search <term>
*Audio:* /transcribe (nota de voz)
*Info:* /help

⚠️ Los comandos /click /type /press /shortcut requieren:
System Preferences > Security & Privacy > Accessibility`;
  },

  async status(chatId, replyTo) {
    const tmuxExists = execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null; echo $?`, { encoding: 'utf8' }).trim();
    const claudeRunning = tmuxExists === '0' ? '✅' : '❌';
    const queueMode = taskQueue ? taskQueue.mode : 'N/A';
    return `📊 *Status*
• Claude: ${claudeRunning}
• Queue: ${queueMode}
• Uptime: ${Math.floor(process.uptime() / 60)} min
• Rate: ${rateLimitMap.size}/${RATE_LIMIT}`;
  },

  async uptime(chatId, replyTo) {
    const uptimeSec = process.uptime();
    const hours = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    return `⏱️ Uptime: ${hours}h ${mins}m`;
  },

  // Screen commands
  async screenshot(chatId, replyTo) {
    const screenshotPath = path.join(os.tmpdir(), `screenshot-${Date.now()}.png`);
    try {
      execSync(`screencapture -x ${screenshotPath}`);
      await sendFileToTelegram(screenshotPath, chatId);
      fs.unlinkSync(screenshotPath);
      return null;
    } catch { return 'Error en screenshot'; }
  },

  async displays(chatId, replyTo) {
    try {
      const displays = execSync('system_profiler SPDisplaysDataType -json', { encoding: 'utf8' });
      const parsed = JSON.parse(displays);
      const count = Object.keys(parsed).length;
      return `🖥️ ${count} display(s) detected`;
    } catch { return 'Error obteniendo info de displays'; }
  },

  // File commands
  async readFile(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /read <path>';
    const filePath = args[0].replace(/^~/, os.homedir());
    try {
      const content = fs.readFileSync(filePath, 'utf8').substring(0, 4000);
      return `📄 ${filePath}\n\n${content}${content.length >= 4000 ? '\n\n...[truncado]' : ''}`;
    } catch { return 'Error leyendo archivo'; }
  },

  async listDir(chatId, replyTo, args) {
    const dirPath = (args && args[0]) ? args[0].replace(/^~/, os.homedir()) : os.homedir();
    try {
      const files = fs.readdirSync(dirPath);
      const list = files.slice(0, 50).join('\n');
      return `📁 ${dirPath}\n\n${list}${files.length > 50 ? `\n\n...y ${files.length - 50} más` : ''}`;
    } catch { return 'Error listando directorio'; }
  },

  // App commands
  async openApp(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /open <app>';
    const appName = args.join(' ');
    try {
      execSync(`open -a "${appName}"`);
      return `✅ Abriendo ${appName}`;
    } catch { return `Error abriendo ${appName}`; }
  },

  async closeApp(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /close <app>';
    const appName = args.join(' ');
    try {
      execSync(`pkill -f "${appName}"`);
      return `✅ Cerrando ${appName}`;
    } catch { return `Error cerrando ${appName}`; }
  },

  async listApps(chatId, replyTo) {
    try {
      const apps = execSync('ls /Applications/*.app 2>/dev/null | xargs -I{} basename {} .app', { encoding: 'utf8' });
      const list = apps.split('\n').slice(0, 30).join('\n');
      return `📱 Apps:\n\n${list}${apps.split('\n').length > 30 ? '\n\n...y más' : ''}`;
    } catch { return 'Error listando apps'; }
  },

  // System info
  async cpu(chatId, replyTo) {
    try {
      const load = execSync('sysctl -n hw.loadavg', { encoding: 'utf8' }).trim();
      return `🖥️ CPU Load: ${load}`;
    } catch { return 'Error obteniedo CPU'; }
  },

  async memory(chatId, replyTo) {
    try {
      const mem = execSync('vm_stat', { encoding: 'utf8' });
      return `🧠 Memory:\n${mem.substring(0, 500)}`;
    } catch { return 'Error obteniedo memory'; }
  },

  async disk(chatId, replyTo) {
    try {
      const disk = execSync('df -h /', { encoding: 'utf8' });
      const lines = disk.trim().split('\n');
      const line = lines[1] || '';
      return `💾 Disk:\n${line}`;
    } catch { return 'Error obteniendo disk'; }
  },

  async processes(chatId, replyTo, args) {
    const n = (args && args[0]) ? parseInt(args[0]) : 5;
    try {
      const top = execSync(`ps auxr -n ${n}`, { encoding: 'utf8' });
      return `📊 Top ${n} procesos:\n\`\`\`\n${top.substring(0, 1000)}\n\`\`\``;
    } catch { return 'Error obteniedo procesos'; }
  },

  // Clipboard
  async copy(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /copy <text>';
    const text = args.join(' ');
    try {
      execSync(`printf '${text}' | pbcopy`);
      return `✅ Copiado al clipboard`;
    } catch { return 'Error copiando'; }
  },

  async paste(chatId, replyTo) {
    try {
      const content = execSync('pbpaste', { encoding: 'utf8' }).trim();
      return `📋 Clipboard:\n${content.substring(0, 1000)}`;
    } catch { return 'Error pegando'; }
  },

  // Task commands
  async inbox(chatId, replyTo) {
    try {
      const files = fs.readdirSync(INBOX_FOLDER).filter(f => f.endsWith('.md'));
      return files.length ? `📥 Inbox:\n${files.join('\n')}` : 'Inbox vacío';
    } catch { return 'Error leyendo Inbox'; }
  },

  async newTask(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /newtask <título>';
    const title = args.join(' ');
    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}_${title.replace(/[^a-zA-Z0-9]/g, '_')}.md`;
    const filepath = path.join(INBOX_FOLDER, filename);
    try {
      fs.writeFileSync(filepath, `# ${title}\n\nCreado: ${new Date().toLocaleString('es-MX')}\n`);
      return `✅ Tarea creada: ${filename}`;
    } catch { return 'Error creando tarea'; }
  },

  // Voice/Audio
  async transcribe(chatId, replyTo) {
    return 'Envia una nota de voz para transcribir';
  },

  // ---- COMPUTER USE TOOL (Mouse/Keyboard) ----
  async click(chatId, replyTo, args) {
    if (!args || args.length < 2) return '用法: /click <x> <y>';
    const [x, y] = args;
    try {
      execSync(`osascript -e 'tell application "System Events" to click at {${x}, ${y}}'`);
      return `✅ Click at (${x}, ${y})`;
    } catch { return 'Error executing click'; }
  },

  async doubleclick(chatId, replyTo, args) {
    if (!args || args.length < 2) return '用法: /doubleclick <x> <y>';
    const [x, y] = args;
    try {
      execSync(`osascript -e 'tell application "System Events" to double click at {${x}, ${y}}'`);
      return `✅ Double click at (${x}, ${y})`;
    } catch { return 'Error executing doubleclick'; }
  },

  async move(chatId, replyTo, args) {
    if (!args || args.length < 2) return '用法: /move <x> <y>';
    const [x, y] = args;
    try {
      execSync(`osascript -e 'tell application "System Events" to set position of mouse to {${x}, ${y}}'`);
      return `✅ Mouse moved to (${x}, ${y})`;
    } catch { return 'Error moving mouse'; }
  },

  async type(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /type <text>';
    const text = args.join(' ').replace(/"/g, '\\"');
    try {
      execSync(`osascript -e 'tell application "System Events" to keystroke "${text}"'`);
      return `✅ Typed: ${args.join(' ').substring(0, 50)}`;
    } catch { return 'Error typing'; }
  },

  async press(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /press <key>';
    const key = args[0].toLowerCase();
    const keyCodes = { 'enter': 36, 'return': 36, 'escape': 53, 'esc': 53, 'tab': 48, 'delete': 51, 'backspace': 51, 'up': 126, 'down': 125, 'left': 123, 'right': 124 };
    const code = keyCodes[key] || 0;
    try {
      execSync(`osascript -e 'tell application "System Events" to key code ${code}'`);
      return `✅ Pressed: ${key}`;
    } catch { return 'Error pressing key'; }
  },

  async shortcut(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /shortcut <keys> (ej: cmd+c, shift+tab)';
    const keys = args[0].toLowerCase().split('+');
    if (keys.length !== 2) return '用法: /shortcut <mod>+<key> (ej: cmd+c)';
    const [mod, key] = keys;
    const modMap = { 'cmd': 'command', 'command': 'command', 'shift': 'shift', 'ctrl': 'control', 'control': 'control', 'alt': 'option', 'option': 'option' };
    const keyCodeMap = { 'c': 8, 'v': 9, 'x': 7, 'z': 6, 'a': 0, 's': 1, 'f': 3, 'tab': 48 };
    const modifier = modMap[mod] || 'command';
    const kc = keyCodeMap[key] || 0;
    try {
      execSync(`osascript -e 'tell application "System Events" to keystroke "${String.fromCharCode(kc)}" using ${modifier} down'`);
      return `✅ Shortcut: ${mod}+${key}`;
    } catch { return 'Error executing shortcut'; }
  },

  // ---- FILE OPERATIONS ----
  async writeFile(chatId, replyTo, args) {
    if (!args || args.length < 2) return '用法: /write <path> <content>';
    const filePath = args[0].replace(/^~/, os.homedir());
    const content = args.slice(1).join(' ');
    try {
      fs.writeFileSync(filePath, content);
      return `✅ Archivo escrito: ${filePath}`;
    } catch { return 'Error escribiendo archivo'; }
  },

  async deleteFile(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /delete <path>';
    const filePath = args[0].replace(/^~/, os.homedir());
    try {
      fs.unlinkSync(filePath);
      return `✅ Eliminado: ${filePath}`;
    } catch { return 'Error eliminando archivo'; }
  },

  async copyFile(chatId, replyTo, args) {
    if (!args || args.length < 2) return '用法: /copy <src> <dst>';
    const src = args[0].replace(/^~/, os.homedir());
    const dst = args[1].replace(/^~/, os.homedir());
    try {
      fs.copyFileSync(src, dst);
      return `✅ Copiado: ${src} → ${dst}`;
    } catch { return 'Error copiando archivo'; }
  },

  async moveFile(chatId, replyTo, args) {
    if (!args || args.length < 2) return '用法: /move <src> <dst>';
    const src = args[0].replace(/^~/, os.homedir());
    const dst = args[1].replace(/^~/, os.homedir());
    try {
      fs.renameSync(src, dst);
      return `✅ Movido: ${src} → ${dst}`;
    } catch { return 'Error moviendo archivo'; }
  },

  // ---- BASH ----
  async bash(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /bash <command>';
    const cmd = args.join(' ');
    try {
      const result = execSync(cmd, { encoding: 'utf8', timeout: 30000 }).substring(0, 2000);
      return `\`\`\`\n${result}\n\`\`\``;
    } catch { return 'Error ejecutando comando'; }
  },

  // ---- SESSION ----
  async restart(chatId, replyTo) {
    try {
      execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`);
      ensureClaudeSession();
      return '✅ Sesión reiniciada';
    } catch { return 'Error reiniciando sesión'; }
  },

  async logs(chatId, replyTo, args) {
    const n = (args && args[0]) ? parseInt(args[0]) : 50;
    try {
      const logPath = path.join(os.homedir(), '.claude', 'telegram-bridge.log');
      const content = fs.readFileSync(logPath, 'utf8').split('\n').slice(-n).join('\n');
      return `📋 Últimas ${n} líneas:\n\`\`\`\n${content.substring(0, 1500)}\n\`\`\``;
    } catch { return 'Logs no disponibles'; }
  },

  // ---- QUEUE / FREEZE ----
  async freeze(chatId, replyTo) {
    if (taskQueue) {
      taskQueue.setMode('frozen');
      return '🧊 Modo freeze activado. Comandos encolados hasta /resume';
    }
    return 'Queue no disponible';
  },

  async resume(chatId, replyTo) {
    if (taskQueue) {
      taskQueue.setMode('sync');
      return '▶️ Modo normal reactivado';
    }
    return 'Queue no disponible';
  },

  async asyncMode(chatId, replyTo) {
    if (taskQueue) {
      taskQueue.setMode('async');
      return '⚡ Modo async activado. Comandos se ejecutan en cola automáticamente.';
    }
    return 'Queue no disponible';
  },

  async queue(chatId, replyTo) {
    if (!taskQueue) return 'Queue no disponible';
    const status = taskQueue.getStatus();
    return `📋 Cola: ${status.queueLength} tareas | Modo: ${status.mode} | Processing: ${status.processing}`;
  },

  async clear(chatId, replyTo) {
    if (!taskQueue) return 'Queue no disponible';
    return taskQueue.clear();
  },

  async cancel(chatId, replyTo, args) {
    if (!taskQueue) return 'Queue no disponible';
    const pos = args && args[0] ? parseInt(args[0]) : 1;
    return taskQueue.cancel(pos);
  },

  // ---- SYSTEM ----
  async network(chatId, replyTo) {
    try {
      const ifaces = execSync('ifconfig', { encoding: 'utf8' });
      const active = ifaces.split('\n\n').filter(s => s.includes('status: active')).map(s => {
        const match = s.match(/^(\w+):/);
        return match ? match[1] : null;
      }).filter(Boolean);
      return `🌐 Interfaces activas: ${active.join(', ') || 'Ninguna'}`;
    } catch { return 'Error obteniendo network'; }
  },

  // ---- SEARCH ----
  async search(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /search <term>';
    const term = args.join(' ');
    try {
      const result = execSync(`grep -r "${term}" ~ 2>/dev/null | head -20`, { encoding: 'utf8', timeout: 10000 });
      return `🔍 Resultados:\n\`\`\`\n${result.substring(0, 1500)}\n\`\`\``;
    } catch { return 'Sin resultados o error'; }
  },

  // ---- SCHEDULE ----
  async cron(chatId, replyTo, args) {
    if (!args || args.length < 2) return '用法: /cron <expr> <cmd>';
    return `⏰ Cron: ${args[0]} → ${args.slice(1).join(' ')}\n(Scheduling completo en fase 6)`;
  },

  async remind(chatId, replyTo, args) {
    if (!args || args.length < 2) return '用法: /remind <time> <msg>';
    const time = args[0];
    const msg = args.slice(1).join(' ');
    return `⏰ Recordatorio: "${msg}" en ${time}\n(Recordatorios completos en fase 6)`;
  },

  async schedule(chatId, replyTo) {
    return '📅 Tareas programadas (en desarrollo)';
  },

  // ---- TASK OPERATIONS ----
  async archive(chatId, replyTo) {
    try {
      const files = fs.readdirSync(ARCHIVE_FOLDER).filter(f => f.endsWith('.md'));
      return files.length ? `📦 Archive:\n${files.join('\n')}` : 'Archive vacío';
    } catch { return 'Error leyendo Archive'; }
  },

  async active(chatId, replyTo) {
    try {
      const files = fs.readdirSync(ACTIVE_FOLDER).filter(f => f.endsWith('.md'));
      return files.length ? `⚡ Active:\n${files.join('\n')}` : 'No hay tareas activas';
    } catch { return 'Error leyendo Active'; }
  },

  async completetask(chatId, replyTo, args) {
    if (!args || !args[0]) return '用法: /completetask <nombre>';
    const taskName = args.join(' ');
    const src = path.join(ACTIVE_FOLDER, taskName);
    const dst = path.join(ARCHIVE_FOLDER, taskName);
    try {
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
        return `✅ Tarea completada: ${taskName}`;
      }
      return 'Tarea no encontrada en Active';
    } catch { return 'Error completando tarea'; }
  },
};

// ============================================
// COMMAND ROUTER
// ============================================

class CommandRouter {
  constructor() {
    this.handlers = Handlers;
  }

  parse(text) {
    const trimmed = text.trim();

    // Solo comandos que empiezan con / van a handlers
    if (trimmed.startsWith('/')) {
      const [cmd, ...args] = trimmed.slice(1).split(' ');
      return { type: 'slash', command: cmd.toLowerCase(), args };
    }

    // Todo lo demás -> Claude
    return { type: 'claude', command: trimmed, args: [] };
  }

  async route(parsed, chatId, replyTo) {
    const { type, command, args } = parsed;

    // Aliases
    const aliasMap = {
      'list': 'listDir',
      'read': 'readFile',
      'write': 'writeFile',
      'shell': 'bash',
      'sh': 'bash',
      'rm': 'deleteFile',
      'cp': 'copyFile',
      'mv': 'moveFile',
      'del': 'deleteFile',
    };

    if (type === 'slash') {
      const handlerName = aliasMap[command] || command;
      const handler = this.handlers[handlerName];

      // Check for sensitive commands (bash, shell)
      if (handlerName === 'bash' && isSensitive(args.join(' '))) {
        return '⚠️ Comando sensible detectado. Esta acción requiere confirmación manual.';
      }

      if (handler) {
        // Build the task to execute
        const task = async () => {
          return await handler(chatId, replyTo, args);
        };

        // In frozen mode, queue but don't execute
        if (taskQueue.mode === 'frozen' && command !== 'resume' && command !== 'freeze' && command !== 'status' && command !== 'queue') {
          taskQueue.add(task);
          return `🧊 Encolado (freeze activo). Posición: ${taskQueue.queue.length}. Usa /resume para continuar.`;
        }

        // Execute through queue
        if (taskQueue.mode === 'async') {
          return taskQueue.add(task);
        }

        // Sync mode - execute directly
        return await handler(chatId, replyTo, args);
      }
      // Unknown slash command -> send to Claude
      return await sendToClaude(`/${command} ${args.join(' ')}`);
    }

    // Natural language or unknown -> send to Claude
    return await sendToClaude(command);
  }
}

// ============================================
// TMUX / CLAUDE
// ============================================

function ensureClaudeSession() {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    console.log('Claude session already running');
    setTimeout(() => {
      try { execSync(`tmux send-keys -t ${TMUX_SESSION} '1' Enter`); } catch {}
    }, 1000);
  } catch {
    console.log('Creating Claude tmux session...');
    const cmd = `tmux new-session -d -s ${TMUX_SESSION} 'cd ${CLAUDE_FOLDER} && ANTHROPIC_AUTH_TOKEN="sk-cp-Iu7lGjFix4Vbw_LYGJCa1iF4UQeagsbqKgpgBDx_YehfUR2YERnRXuERJ55AUXN4WtXAoJOfE2BoABfjPJYdssgwWM236OOnrdozX1fL0N8NM_JliTnfG0o" ANTHROPIC_BASE_URL="https://api.minimax.io/anthropic" ANTHROPIC_MODEL="MiniMax-M2.7" claude --dangerously-skip-permissions; sleep infinity'`;
    execSync(cmd, { stdio: 'inherit' });
    console.log('Claude session created');
    setTimeout(() => {
      try { execSync(`tmux send-keys -t ${TMUX_SESSION} '1' Enter`); } catch {}
    }, 3000);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function tmux(command, options = {}) {
  return execSync(`tmux ${command}`, { encoding: 'utf8', ...options });
}

function isPromptLine(line) {
  const trimmed = line.trim();
  return trimmed === '❯' || /^❯(\s|$)/.test(trimmed) || trimmed === 'claude >' || /^claude >/.test(trimmed);
}

function isIdlePromptLine(line) {
  const trimmed = stripAnsi(line).trim();
  return trimmed === '❯' || trimmed === 'claude >';
}

function getPaneState() {
  try {
    const out = tmux(`display-message -p -t ${TMUX_SESSION} '#{history_size} #{cursor_y} #{pane_height}'`);
    const [historySize, cursorY, paneHeight] = out.trim().split(/\s+/).map(Number);
    return { historySize: historySize || 0, cursorY: cursorY || 0, paneHeight: paneHeight || 24 };
  } catch {
    return { historySize: 0, cursorY: 0, paneHeight: 24 };
  }
}

function capturePane(start, end) {
  let command = `capture-pane -p -t ${TMUX_SESSION}`;
  if (typeof start === 'number') command += ` -S ${start}`;
  if (typeof end === 'number') command += ` -E ${end}`;
  return tmux(command);
}

function getPanePos() {
  try {
    const out = tmux(`display-message -p -t ${TMUX_SESSION} '#{history_size} #{cursor_y}'`);
    const [historySize, cursorY] = out.trim().split(/\s+/).map(Number);
    return { historySize, cursorY };
  } catch {
    return { historySize: 0, cursorY: 0 };
  }
}

function captureTail(lines = 12) {
  return capturePane(-Math.max(lines, 1));
}

function dismissTrustPrompt() {
  try {
    const capture = captureTail(12);
    if (capture.includes('trust this folder') || capture.includes('Yes, I trust')) {
      tmux(`send-keys -t ${TMUX_SESSION} 1 Enter`);
    }
  } catch {}
}

function lineMatchesCommand(line, command) {
  const cleaned = cleanContentLine(line.replace(/^❯\s*/, ''));
  return normalizeComparable(cleaned) === normalizeComparable(command);
}

function hasIdlePromptAfterCommand(text, command) {
  const lines = stripAnsi(text).split('\n');
  const lastCommandIndex = lines.reduce((found, line, index) => (
    lineMatchesCommand(line, command) ? index : found
  ), -1);

  if (lastCommandIndex < 0) {
    return false;
  }

  return lines
    .slice(lastCommandIndex + 1)
    .some(line => isIdlePromptLine(line));
}

// Wait for a NEW prompt to appear after the beforePosition
// Used for voice messages where we need to wait for Claude's response to OUR command
function waitForNewPrompt(beforePosition, maxWait = 45000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let lastPaneState = '';
    let stableCount = 0;

    const check = () => {
      try {
        const currentPos = getPanePos();
        const afterPos = currentPos.historySize + currentPos.cursorY;

        // If position has advanced past our before position, there's new content
        if (afterPos > beforePosition) {
          const pane = capturePane(100);
          const parsed = parseOutput(pane, '');

          // Check if we see a prompt that's NOT from before (look for fresh content)
          const lines = pane.split('\n');
          let foundNewPrompt = false;
          for (let i = lines.length - 1; i >= 0; i--) {
            if (isIdlePromptLine(lines[i])) {
              // Found a prompt - is it after our before position?
              if (i > 5) { // Not near the top, so it's a new prompt
                foundNewPrompt = true;
                break;
              }
            }
          }

          if (foundNewPrompt && parsed && parsed.trim()) {
            if (parsed === lastPaneState) {
              stableCount++;
            } else {
              lastPaneState = parsed;
              stableCount = 1;
            }

            if (stableCount >= 2) {
              resolve(parsed);
              return;
            }
          }
        }
      } catch (err) {
        console.log('waitForNewPrompt check error:', err.message);
      }

      if (Date.now() - start > maxWait) {
        reject(new Error('Timeout waiting for new prompt'));
        return;
      }
      setTimeout(check, 300);
    };

    check();
  });
}

function waitForPrompt(beforeTail, command, maxWait = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let sawActivity = false;
    let stableCount = 0;
    let lastParsed = null;

    const check = () => {
      try {
        const tail = captureTail(80);
        if (tail !== beforeTail) {
          sawActivity = true;
        }

        const parsed = parseOutput(tail, command);
        const idlePromptReady = hasIdlePromptAfterCommand(tail, command);

        if (sawActivity && idlePromptReady) {
          if (parsed === lastParsed) {
            stableCount += 1;
          } else {
            lastParsed = parsed;
            stableCount = 1;
          }

          if (parsed && stableCount >= 2) {
            resolve(parsed);
            return;
          }
        }
      } catch {}

      if (Date.now() - start > maxWait) {
        reject(new Error('Timeout waiting for prompt'));
        return;
      }
      setTimeout(check, 200);
    };

    check();
  });
}

function hasPrompt(text) {
  return stripAnsi(text)
    .split('\n')
    .some(line => isPromptLine(line));
}

function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[\?[0-9;]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\[[0-9;:]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function normalizeComparable(text) {
  return stripAnsi(text).trim().replace(/\s+/g, ' ');
}

function isNoiseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^[-─│├┤┃┌┐└┘╭╮╯╰┼═]+$/.test(trimmed)) return true;
  if (/^[⏺◐⏵●○✳✶✽✢✣·•]+$/.test(trimmed)) return true;

  const lower = trimmed.toLowerCase();
  if (lower.includes('bypass permissions')) return true;
  if (lower.startsWith('tip:') || lower.startsWith('💡 tip:')) return true;
  if (lower.includes('claude code v')) return true;
  if (lower.includes('minimax')) return true;
  if (lower.includes('claude.ai/code')) return true;
  if (lower.includes('run claude')) return true;
  if (lower.includes('desktop app')) return true;
  if (lower.includes('(thinking)') || lower.includes('thinking...')) return true;
  if (lower.includes('(waiting)')) return true;
  if (/^[⏺◐⏵●○✳✶✽✢✣·•]+\s+[a-z].*[\u2026.]$/i.test(trimmed)) return true;
  if (/^[a-z]+(?:ing|ating|izing|izing|ifying|ating)\u2026?$/i.test(trimmed)) return true;

  return false;
}

function cleanContentLine(line) {
  let cleaned = stripAnsi(line).replace(/\s+$/g, '').trim();
  cleaned = cleaned.replace(/^[⏺◐⏵●○✳✶✽✢✣·•]+\s*/, '');
  cleaned = cleaned.replace(/^[│┃]\s?/, '').replace(/\s?[│┃]$/, '');
  return cleaned.trim();
}

function parseOutput(text, command) {
  const lines = stripAnsi(text).split('\n');
  const normalizedCommand = normalizeComparable(command);
  const responseLines = [];
  let startIndex = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = cleanContentLine(lines[i].replace(/^❯\s*/, ''));
    if (normalizeComparable(candidate) === normalizedCommand) {
      startIndex = i;
      break;
    }
  }

  const relevantLines = startIndex >= 0 ? lines.slice(startIndex + 1) : lines;

  for (const rawLine of relevantLines) {
    const trimmed = stripAnsi(rawLine).trim();

    if (isPromptLine(trimmed)) {
      break;
    }

    let cleaned = cleanContentLine(rawLine);
    if (!cleaned) continue;
    if (cleaned === '❯') continue;
    if (normalizeComparable(cleaned) === normalizedCommand) continue;
    if (isNoiseLine(cleaned)) continue;

    if (/^❯\s+/.test(cleaned)) {
      break;
    }

    responseLines.push(cleaned);
  }

  return responseLines.join('\n').trim();
}

function captureLastBlock(beforeState, afterState) {
  const beforeAbs = beforeState.historySize + beforeState.cursorY;
  const afterAbs = afterState.historySize + afterState.cursorY;
  const startAbs = beforeAbs + 1;
  const endAbs = afterAbs - 1;

  if (endAbs < startAbs) {
    return '';
  }

  const startRel = startAbs - afterState.historySize;
  const endRel = endAbs - afterState.historySize;

  try {
    return capturePane(startRel, endRel);
  } catch {
    return '';
  }
}

function fallbackCapture(command, afterState) {
  try {
    const historyWindow = Math.max(afterState.paneHeight + afterState.historySize + 40, 80);
    return parseOutput(capturePane(-historyWindow), command);
  } catch {
    return '';
  }
}

function sendToClaude(command) {
  return new Promise((resolve, reject) => {
    dismissTrustPrompt();

    const beforeState = getPaneState();
    const beforeTail = captureTail(16);

    try {
      tmux(`send-keys -t ${TMUX_SESSION} -l -- ${shellQuote(command)}`);
      tmux(`send-keys -t ${TMUX_SESSION} Enter`);
      console.log(`Sent: ${command.substring(0, 50)}...`);
    } catch (err) {
      reject(new Error('Failed to send command'));
      return;
    }

    waitForPrompt(beforeTail, command, 20000)
      .then(parsedResponse => {
        const afterState = getPaneState();
        let cleaned = parsedResponse || fallbackCapture(command, afterState);

        if (!cleaned) {
          const block = captureLastBlock(beforeState, afterState);
          cleaned = parseOutput(block, command);
        }

        let fileNotification = '';
        try {
          const files = fs.readdirSync(INBOX_FOLDER).filter(f => f.endsWith('.md'));
          if (files.length > 0) fileNotification = '\n\nPendientes en Inbox: ' + files.join(', ');
        } catch {}

        resolve((cleaned || 'OK') + fileNotification);
      })
      .catch(() => {
        const afterState = getPaneState();
        let cleaned = fallbackCapture(command, afterState);

        if (!cleaned) {
          const block = captureLastBlock(beforeState, afterState);
          cleaned = parseOutput(block, command);
        }

        resolve(cleaned || 'Timeout');
      });
  });
}

// ============================================
// TASK QUEUE (Full Implementation)
// ============================================

const taskQueue = {
  queue: [],
  mode: 'sync',  // sync | async | frozen
  processing: false,
  maxIterations: 50,

  add(task) {
    if (this.mode === 'sync') {
      return this.executeSync(task);
    }
    this.queue.push(task);
    if (this.mode === 'frozen') {
      return { status: 'frozen_queued', position: this.queue.length, message: 'Comando encolado (modo freeze activo)' };
    }
    return { status: 'queued', position: this.queue.length };
  },

  async executeSync(taskFn) {
    this.processing = true;
    try {
      const result = await taskFn();
      return result;
    } finally {
      this.processing = false;
      this.processNext();
    }
  },

  async processNext() {
    if (this.queue.length === 0) return;
    if (this.processing) return;
    const next = this.queue.shift();
    this.processing = true;
    try {
      await next();
    } finally {
      this.processing = false;
      this.processNext();
    }
  },

  setMode(mode) {
    const oldMode = this.mode;
    this.mode = mode;
    console.log(`Queue mode changed: ${oldMode} -> ${mode}`);
    if (mode === 'sync' && oldMode === 'frozen') {
      this.processNext();
    }
  },

  clear() {
    this.queue = [];
    return `🗑️ Cola limpiada (${this.queue.length} tareas eliminadas)`;
  },

  cancel(position) {
    if (position < 1 || position > this.queue.length) {
      return `Posición ${position} inválida`;
    }
    const removed = this.queue.splice(position - 1, 1);
    return `Tarea cancelada: ${removed[0]?.name || 'desconocida'}`;
  },

  getStatus() {
    return {
      mode: this.mode,
      queueLength: this.queue.length,
      processing: this.processing
    };
  }
};

// ============================================
// RATE LIMITING
// ============================================

function checkRateLimit(userId) {
  const now = Date.now();
  const key = `rate_${userId}`;
  const data = rateLimitMap.get(key) || { count: 0, windowStart: now };

  if (now - data.windowStart > RATE_WINDOW) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (data.count >= RATE_LIMIT) return false;
  data.count++;
  rateLimitMap.set(key, data);
  return true;
}

// ============================================
// WEBHOOK SERVER
// ============================================

function startWebhookServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/webhook') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);

          // Validate secret
          if (data.secret !== WEBHOOK_SECRET) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }

          const chatId = data.chat_id || ALLOWED_USER_ID;
          const command = data.command || '';

          // Route command
          const router = new CommandRouter();
          const result = await router.route(router.parse(command), chatId, null);

          // Send response back
          if (result) {
            await sendMessageToTelegram(chatId, result);
          }

          res.writeHead(200);
          res.end(JSON.stringify({ success: true, response: result }));
        } catch (err) {
          console.error('Webhook error:', err.message);
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(WEBHOOK_PORT, () => {
    console.log(`Webhook server listening on port ${WEBHOOK_PORT}`);
  });
}

// Direct API call to MiniMax (fast, no tmux)
async function directClaudeRequest(message) {
  const response = await fetch('https://api.minimax.io/anthropic/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN || 'sk-cp-Iu7lGjFix4Vbw_LYGJCa1iF4UQeagsbqKgpgBDx_YehfUR2YERnRXuERJ55AUXN4WtXAoJOfE2BoABfjPJYdssgwWM236OOnrdozX1fL0N8NM_JliTnfG0o'}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'MiniMax-M2.7',
      max_tokens: 4096,
      messages: [{ role: 'user', content: message }]
    })
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();

  // Extract text from response (skip thinking blocks)
  let text = '';
  for (const block of data.content) {
    if (block.type === 'text') {
      text += block.text;
    }
  }

  // Clean up LaTeX artifacts like \(...\) and \[
  text = text.replace(/\\\((.*?)\\\)/g, '$1').replace(/\\\[(.*?)\\\]/g, '$1').replace(/\$(.*?)\$/g, '$1');

  return text.trim();
}

// ============================================
// VOICE MESSAGE HANDLER - USA OPENAI WHISPER SOLO PARA TRANSCRIPCIÓN
// ============================================

async function handleVoiceMessage(fileId, chatId) {
  try {
    // Descargar audio de Telegram
    const fileInfo = await telegramRequest('getFile', { file_id: fileId });
    if (!fileInfo.ok) return 'Error obteniendo file info';

    const filePath = fileInfo.result.file_path;
    const audioUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    const ogaPath = path.join(os.tmpdir(), `voice-${Date.now()}.oga`);
    const mp3Path = path.join(os.tmpdir(), `voice-${Date.now()}.mp3`);
    const txtPath = path.join(os.tmpdir(), `voice-${Date.now()}.txt`);

    // Download audio
    await new Promise((resolve, reject) => {
      https.get(audioUrl, (res) => {
        const stream = fs.createWriteStream(ogaPath);
        res.pipe(stream);
        stream.on('finish', resolve);
        stream.on('error', reject);
      }).on('error', reject);
    });

    // Convert oga to mp3 using ffmpeg (better compatibility)
    try {
      execSync(`/usr/local/bin/ffmpeg -y -i "${ogaPath}" -vn -acodec libmp3lame -q:a 2 "${mp3Path}" 2>/dev/null`);
    } catch {
      // Try afconvert as fallback
      try {
        execSync(`afconvert "${ogaPath}" "${mp3Path}" -f mp4f -d aac`);
      } catch {
        fs.copyFileSync(ogaPath, mp3Path);
      }
    }

    // Verify file exists and has content
    const stats = fs.statSync(mp3Path);
    console.log('Voice: Audio file size:', stats.size);

    if (stats.size < 100) {
      return 'Error: Audio file too small or empty';
    }

    // ========== OPENAI WHISPER API - SOLO PARA TRANSCRIPCIÓN ==========
    // Crear multipart/form-data manualmente
    const fileContent = fs.readFileSync(mp3Path);
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="model"\r\n\r\n`),
      Buffer.from('whisper-1'),
      Buffer.from(`\r\n--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="audio.mp3"\r\n`),
      Buffer.from(`Content-Type: audio/mpeg\r\n\r\n`),
      fileContent,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      body: body
    });

    if (!whisperResponse.ok) {
      throw new Error(`Whisper API error: ${whisperResponse.status}`);
    }

    const whisperResult = await whisperResponse.json();
    const transcription = whisperResult.text || '';

    if (!transcription) {
      return '🎤 Audio recibido pero no pude transcribirlo.';
    }

    // Enviar transcripción a Claude usando sendToClaude() (misma lógica que texto)
    console.log('Voice: Transcripción:', transcription.substring(0, 50));

    let claudeResponse = '';
    try {
      // sendToClaude() ya maneja: enviar comando, esperar prompt, capturar, parsear
      claudeResponse = await sendToClaude(transcription);
      console.log('Voice: Respuesta de Claude:', claudeResponse.substring(0, 50));
    } catch (err) {
      console.error('Voice: Error enviando a Claude:', err.message);
      claudeResponse = 'Error obteniendo respuesta de Claude';
    }

    // Cleanup
    try { fs.unlinkSync(ogaPath); } catch {}
    try { fs.unlinkSync(mp3Path); } catch {}

    // Devolver la respuesta de Claude
    if (claudeResponse && claudeResponse.trim()) {
      return `🎤 "${transcription}"\n\n${claudeResponse}`;
    }
    return `🎤 Transcripción: "${transcription.substring(0, 100)}${transcription.length > 100 ? '...' : ''}"`;

  } catch (err) {
    console.error('Voice handle error:', err.message);
    return 'Error procesando audio: ' + err.message;
  }
}

// ============================================
// MAIN POLLING LOOP
// ============================================

async function main() {
  console.log('Claude Telegram Bridge started (v2 - CommandRouter)');
  console.log(`Bot: ${TELEGRAM_BOT_TOKEN.substring(0, 10)}... | User: ${ALLOWED_USER_ID}`);
  ensureClaudeSession();
  startWebhookServer();

  const router = new CommandRouter();

  while (true) {
    try {
      const offset = loadOffset();
      const updates = await telegramRequest('getUpdates', { offset: offset, timeout: 30 });

      if (updates.ok && updates.result && updates.result.length > 0) {
        for (const update of updates.result) {
          const msg = update.message;
          if (!msg) continue;
          if (msg.from?.is_bot) { await saveOffset(update.update_id + 1); continue; }

          const chatId = msg.chat.id.toString();
          const userId = msg.from.id.toString();
          const replyTo = msg.message_id;

          // Rate limiting
          if (!checkRateLimit(userId)) {
            await sendMessageToTelegram(chatId, '⚡ Demasiados comandos. Espera un momento.', replyTo);
            await saveOffset(update.update_id + 1);
            continue;
          }

          // Handle voice messages
          if (msg.voice) {
            const transcription = await handleVoiceMessage(msg.voice.file_id, chatId);
            await sendMessageToTelegram(chatId, transcription, replyTo);
            await saveOffset(update.update_id + 1);
            continue;
          }

          const text = msg.text || '';
          if (!text.trim()) { await saveOffset(update.update_id + 1); continue; }

          if (userId !== ALLOWED_USER_ID) {
            await sendMessageToTelegram(chatId, 'No autorizado', replyTo);
            await saveOffset(update.update_id + 1);
            continue;
          }

          // Route command
          const parsed = router.parse(text);
          const result = await router.route(parsed, chatId, replyTo);

          if (result) {
            const finalResult = result.length > 4000 ? result.substring(0, 4000) + '\n\n...[truncado]...' : result;
            await sendMessageToTelegram(chatId, finalResult, replyTo);
          }

          await saveOffset(update.update_id + 1);
        }
      }
    } catch (err) {
      console.error('Error:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

main();
