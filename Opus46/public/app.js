/* ClaudeClaw PWA — app.js */
'use strict';

// ── CONFIGURACIÓN ──────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/ping',       desc: 'Verificar que el bridge responde' },
  { cmd: '/fecha',      desc: 'Fecha actual' },
  { cmd: '/hora',       desc: 'Hora actual' },
  { cmd: '/status',     desc: 'Estado del bridge y la cola' },
  { cmd: '/uptime',     desc: 'Tiempo en ejecución' },
  { cmd: '/mem',        desc: 'Uso de RAM' },
  { cmd: '/disk',       desc: 'Uso de disco' },
  { cmd: '/screenshot', desc: 'Captura de pantalla del escritorio' },
  { cmd: '/bash',       desc: 'Ejecutar comando shell' },
  { cmd: '/read',       desc: 'Leer archivo' },
  { cmd: '/list',       desc: 'Listar directorio' },
  { cmd: '/pbpaste',    desc: 'Pegar del clipboard' },
];

// ── ESTADO ────────────────────────────────────────────────────
let ws = null;
let wsRetryMs = 1000;
let isAtBottomFlag = true;
let currentDir = '';
let soundEnabled = false;
let mediaRecorder = null;
let audioChunks = [];
let slashSelectedIdx = -1;
let historyBeforeTs = null;
let loadingHistory = false;

// ── HELPERS DOM ───────────────────────────────────────────────
const $ = id => document.getElementById(id);
const loginScreen   = $('login-screen');
const app           = $('app');
const chatEl        = $('chat');
const inputEl       = $('message-input');
const sendBtn       = $('send-btn');
const statusDot     = $('status-dot');
const typingEl      = $('typing-indicator');
const typingText    = $('typing-text');
const mascotThink   = $('mascot-thinking');
const mascotIcon    = $('mascot-icon');
const filesList     = $('files-list');
const filesSidebar  = $('files-sidebar');
const slashPopup    = $('slash-popup');
const searchBar     = $('search-bar');
const searchInput   = $('search-input');
const previewModal  = $('preview-modal');
const previewBody   = $('preview-body');
const previewTitle  = $('preview-title');
const settingsModal = $('settings-modal');

// ── AUTH TOKEN ───────────────────────────────────────────────
function getToken() { return localStorage.getItem('bridge_token') || ''; }
function setToken(t) { localStorage.setItem('bridge_token', t); }
function authHeaders() {
  const t = getToken();
  return t ? { 'X-Bridge-Token': t } : {};
}

// ── LOGIN ─────────────────────────────────────────────────────
async function tryLogin(password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return res.ok;
}

async function checkAuth() {
  // Verificar si ya tenemos sesión válida
  try {
    const res = await fetch('/api/history?limit=1', { headers: authHeaders() });
    if (res.ok) return true;
  } catch {}
  return false;
}

// ── INIT ──────────────────────────────────────────────────────
async function init() {
  // Si no hay BRIDGE_PASSWORD configurado, /api/history devuelve 200 sin auth
  const authed = await checkAuth();
  if (authed) {
    showApp();
  } else {
    loginScreen.classList.remove('hidden');
  }
}

function showApp() {
  loginScreen.classList.add('hidden');
  app.classList.remove('hidden');
  connectWS();
  loadHistory();
  loadFiles();
  setupStatusPoller();
}

// ── WEBSOCKET ─────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken();
  const url = `${proto}//${location.host}/ws${token ? '?token=' + encodeURIComponent(token) : ''}`;

  setStatus('connecting');
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setStatus('online');
    wsRetryMs = 1000;
    // Keepalive ping cada 25s
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      else clearInterval(ping);
    }, 25_000);
  });

  ws.addEventListener('message', e => {
    try { handleWSEvent(JSON.parse(e.data)); } catch {}
  });

  ws.addEventListener('close', () => {
    setStatus('offline');
    setTimeout(connectWS, wsRetryMs);
    wsRetryMs = Math.min(wsRetryMs * 2, 30_000);
  });

  ws.addEventListener('error', () => { ws.close(); });
}

function handleWSEvent(ev) {
  switch (ev.type) {
    case 'message':
      appendMessage(ev);
      if (ev.role === 'assistant' && soundEnabled) playChime();
      break;
    case 'typing':
      if (ev.active) {
        typingEl.classList.remove('hidden');
        mascotThink?.classList.add('thinking');
        mascotIcon?.classList.add('thinking');
      } else {
        typingEl.classList.add('hidden');
        mascotThink?.classList.remove('thinking');
        mascotIcon?.classList.remove('thinking');
      }
      break;
    case 'thinking':
      typingEl.classList.remove('hidden');
      if (typingText) typingText.textContent = `Claude: ${ev.label || ev.tool}`;
      break;
    case 'error':
      handleWSError(ev);
      break;
  }
}

function handleWSError(ev) {
  const msgs = {
    minimax_unavailable: 'MiniMax no disponible, reintentando...',
    queue_full: 'Claude ocupado, intenta en unos segundos',
    timeout: 'Claude tardó demasiado, intenta de nuevo',
  };
  showToast(msgs[ev.code] || ev.message || 'Error desconocido', 'error');
}

function setStatus(s) {
  statusDot.className = `status-dot ${s}`;
  statusDot.title = { online: 'Conectado', offline: 'Desconectado', connecting: 'Conectando...' }[s] || s;
}

// ── HISTORIAL ─────────────────────────────────────────────────
async function loadHistory(before = null, search = null) {
  if (loadingHistory) return;
  loadingHistory = true;
  try {
    let url = `/api/history?limit=40`;
    if (before) url += `&before=${before}`;
    if (search) url += `&q=${encodeURIComponent(search)}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const msgs = await res.json();
    if (!before) chatEl.innerHTML = ''; // reset si es primera carga
    msgs.forEach(m => appendMessage(m, true)); // prepend=true para historial
    if (msgs.length > 0 && !before) {
      historyBeforeTs = msgs[0].created_at;
      scrollToBottom();
    }
    if (msgs.length > 0 && before) {
      historyBeforeTs = msgs[0].created_at;
    }
  } catch {}
  loadingHistory = false;
}

// ── RENDERIZAR MENSAJES ───────────────────────────────────────
function appendMessage(msg, prepend = false) {
  const row = document.createElement('div');
  row.className = `msg-row ${msg.role}`;
  row.dataset.uuid = msg.uuid || '';

  const bubble = document.createElement('div');
  bubble.className = `bubble ${msg.role} channel-${msg.channel || 'pwa'}`;

  if (msg.role === 'assistant') {
    bubble.innerHTML = renderMarkdown(msg.content || '');
    // Syntax highlighting
    setTimeout(() => {
      bubble.querySelectorAll('pre code').forEach(el => { if (window.Prism) Prism.highlightElement(el); });
      // Copy buttons
      bubble.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = '📋';
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(pre.textContent.replace(/📋|✅/g, '').trim());
          btn.textContent = '✅';
          setTimeout(() => btn.textContent = '📋', 2000);
        });
        pre.appendChild(btn);
      });
    }, 0);
  } else {
    bubble.textContent = msg.content || '';
  }

  // Meta (hora + canal)
  const meta = document.createElement('div');
  meta.className = 'bubble-meta';
  const ts = msg.created_at ? new Date(msg.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '';
  meta.innerHTML = `<span>${ts}</span>`;
  if (msg.channel && msg.channel !== 'pwa') {
    const badge = document.createElement('span');
    badge.className = 'channel-badge';
    badge.textContent = msg.channel === 'telegram' ? 'tg' : msg.channel;
    meta.appendChild(badge);
  }
  if (msg.starred) {
    const star = document.createElement('span');
    star.textContent = '⭐';
    meta.appendChild(star);
  }

  // Acciones en hover
  const actions = document.createElement('div');
  actions.className = 'bubble-actions';
  actions.innerHTML = `
    <button class="act-copy">📋 Copiar</button>
    <button class="act-star">${msg.starred ? '★ Guardado' : '☆ Guardar'}</button>
    ${msg.role === 'assistant' ? '<button class="act-continue">↩️ Continuar</button>' : ''}
  `;
  actions.querySelector('.act-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(msg.content || '');
    showToast('Copiado', 'success');
  });
  actions.querySelector('.act-star').addEventListener('click', async (e) => {
    const starred = !msg.starred;
    msg.starred = starred;
    e.target.textContent = starred ? '★ Guardado' : '☆ Guardar';
    await fetch(`/api/messages/${msg.uuid}/star`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ starred }),
    });
  });
  const continueBtn = actions.querySelector('.act-continue');
  if (continueBtn) {
    continueBtn.addEventListener('click', () => sendMessage('continúa donde te quedaste'));
  }

  row.appendChild(bubble);
  row.appendChild(meta);
  row.appendChild(actions);

  // Botón "Continuar" si la respuesta parece incompleta
  if (msg.role === 'assistant' && msg.content && /[^.!?…"')\]}\w]$/.test(msg.content.trimEnd())) {
    const cb = document.createElement('button');
    cb.className = 'continue-btn';
    cb.textContent = '↩️ Continuar respuesta';
    cb.addEventListener('click', () => { cb.remove(); sendMessage('continúa donde te quedaste'); });
    row.appendChild(cb);
  }

  const wasAtBottom = isAtBottom();
  if (prepend) {
    chatEl.insertBefore(row, chatEl.firstChild);
  } else {
    chatEl.appendChild(row);
    if (wasAtBottom) scrollToBottom();
  }
}

function renderMarkdown(text) {
  if (!window.marked) return escapeHtml(text).replace(/\n/g, '<br>');
  try {
    return marked.parse(text, { breaks: true, gfm: true });
  } catch {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── SCROLL ────────────────────────────────────────────────────
function isAtBottom() {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
}
function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Scroll infinito hacia arriba para cargar más historial
chatEl.addEventListener('scroll', () => {
  if (chatEl.scrollTop < 80 && historyBeforeTs && !loadingHistory) {
    const prevH = chatEl.scrollHeight;
    loadHistory(historyBeforeTs).then(() => {
      // Mantener posición de scroll
      chatEl.scrollTop = chatEl.scrollHeight - prevH;
    });
  }
});

// ── ENVIAR MENSAJE ────────────────────────────────────────────
async function sendMessage(text) {
  const msg = (text || inputEl.value).trim();
  if (!msg) return;
  if (!text) inputEl.value = '';
  autoResizeTextarea();
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message: msg }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.error === 'queue_full') showToast('Cola llena, intenta en unos segundos', 'error');
      else showToast('Error enviando mensaje', 'error');
    }
    // Los mensajes llegan via WebSocket (broadcast)
  } catch {
    showToast('Sin conexión', 'error');
  } finally {
    sendBtn.disabled = false;
    inputEl.focus();
  }
}

// ── INPUT HANDLERS ────────────────────────────────────────────
sendBtn.addEventListener('click', () => sendMessage());

inputEl.addEventListener('keydown', e => {
  // Ctrl+Enter → enviar
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault(); sendMessage(); return;
  }
  // Enter sin shift → enviar (solo en mobile o si se prefiere)
  // En desktop mantenemos Enter = salto de línea para comodidad

  // Slash autocomplete navigation
  if (!slashPopup.classList.contains('hidden')) {
    const items = slashPopup.querySelectorAll('.slash-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); slashSelectedIdx = Math.min(slashSelectedIdx + 1, items.length - 1); updateSlashSelection(items); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); slashSelectedIdx = Math.max(slashSelectedIdx - 1, 0); updateSlashSelection(items); }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (slashSelectedIdx >= 0 && items[slashSelectedIdx]) {
        items[slashSelectedIdx].click();
      }
    }
    if (e.key === 'Escape') slashPopup.classList.add('hidden');
  }
});

inputEl.addEventListener('input', () => {
  autoResizeTextarea();
  updateSlashPopup();
});

function autoResizeTextarea() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
}

// ── SLASH AUTOCOMPLETE ────────────────────────────────────────
function updateSlashPopup() {
  const val = inputEl.value;
  if (!val.startsWith('/') || val.includes(' ')) {
    slashPopup.classList.add('hidden');
    return;
  }
  const filter = val.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter(c => c.cmd.slice(1).startsWith(filter));
  if (!matches.length) { slashPopup.classList.add('hidden'); return; }

  slashPopup.innerHTML = matches.map((c, i) =>
    `<div class="slash-item" data-cmd="${c.cmd}">
      <code>${c.cmd}</code><span>${c.desc}</span>
    </div>`
  ).join('');
  slashPopup.querySelectorAll('.slash-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      inputEl.value = el.dataset.cmd + ' ';
      slashPopup.classList.add('hidden');
      slashSelectedIdx = -1;
      inputEl.focus();
    });
    el.addEventListener('mouseenter', () => {
      slashSelectedIdx = i;
      updateSlashSelection(slashPopup.querySelectorAll('.slash-item'));
    });
  });
  slashSelectedIdx = 0;
  updateSlashSelection(slashPopup.querySelectorAll('.slash-item'));
  slashPopup.classList.remove('hidden');
}

function updateSlashSelection(items) {
  items.forEach((el, i) => el.classList.toggle('selected', i === slashSelectedIdx));
}

// ── FILE UPLOAD ───────────────────────────────────────────────
$('attach-btn').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => {
  [...e.target.files].forEach(uploadFile);
  e.target.value = '';
});

async function uploadFile(file) {
  showToast(`Subiendo ${file.name}...`);
  const form = new FormData();
  form.append('file', file, file.name);
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: authHeaders(),
      body: form,
    });
    if (!res.ok) throw new Error('upload failed');
    const data = await res.json();
    showToast(`${file.name} guardado`, 'success');
    // Enviar referencia a Claude
    const msg = `Analiza el archivo que acabo de subir: ${data.path}`;
    inputEl.value = msg;
    autoResizeTextarea();
    loadFiles(); // refrescar lista
  } catch {
    showToast(`Error subiendo ${file.name}`, 'error');
  }
}

// Drag & drop al área de chat
const chatMain = $('chat-main');
chatMain.addEventListener('dragover', e => { e.preventDefault(); chatMain.classList.add('drop-active'); });
chatMain.addEventListener('dragleave', () => chatMain.classList.remove('drop-active'));
chatMain.addEventListener('drop', e => {
  e.preventDefault();
  chatMain.classList.remove('drop-active');
  [...e.dataTransfer.files].forEach(uploadFile);
});

// ── VOZ ───────────────────────────────────────────────────────
const micBtn = $('mic-btn');
if (navigator.mediaDevices?.getUserMedia) {
  let maxTimer;
  micBtn.addEventListener('mousedown', startRecording);
  micBtn.addEventListener('touchstart', e => { e.preventDefault(); startRecording(); });
  micBtn.addEventListener('mouseup', stopRecording);
  micBtn.addEventListener('touchend', stopRecording);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
      mediaRecorder.start();
      micBtn.classList.add('recording');
      // Máximo 120s
      maxTimer = setTimeout(stopRecording, 120_000);
    } catch {
      showToast('No se pudo acceder al micrófono', 'error');
    }
  }

  async function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    clearTimeout(maxTimer);
    mediaRecorder.addEventListener('stop', async () => {
      const blob = new Blob(audioChunks, { type: 'audio/ogg' });
      micBtn.classList.remove('recording');
      if (blob.size < 1000) return; // muy corto
      showToast('Transcribiendo...');
      try {
        const form = new FormData();
        form.append('file', blob, 'voice.ogg');
        const res = await fetch('/api/upload?transcribe_only=1', {
          method: 'POST',
          headers: authHeaders(),
          body: form,
        });
        const data = await res.json();
        if (data.text) {
          inputEl.value = data.text;
          autoResizeTextarea();
          inputEl.focus();
          showToast('Transcripción lista', 'success');
        } else {
          showToast('No se entendió el audio', 'error');
        }
      } catch {
        showToast('Error transcribiendo', 'error');
      }
      // Parar tracks
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }, { once: true });
    mediaRecorder.stop();
  }
} else {
  micBtn.style.display = 'none';
}

// ── FILE HUB ─────────────────────────────────────────────────
async function loadFiles(dir = currentDir) {
  currentDir = dir;
  filesList.innerHTML = '<div class="loading-msg">Cargando...</div>';
  try {
    const res = await fetch(`/api/files?dir=${encodeURIComponent(dir)}`, { headers: authHeaders() });
    if (!res.ok) { filesList.innerHTML = '<div class="loading-msg">Error cargando archivos</div>'; return; }
    const items = await res.json();
    renderFilesList(items, dir);
  } catch {
    filesList.innerHTML = '<div class="loading-msg">Sin conexión</div>';
  }
}

function renderFilesList(items, dir) {
  if (!items.length) { filesList.innerHTML = '<div class="loading-msg">Carpeta vacía</div>'; return; }
  filesList.innerHTML = '';

  // Back button si no estamos en raíz
  if (dir) {
    const back = document.createElement('div');
    back.className = 'file-item dir-item';
    back.textContent = '⬆️ ..';
    back.addEventListener('click', () => {
      const parent = dir.split('/').slice(0, -1).join('/');
      loadFiles(parent);
    });
    filesList.appendChild(back);
  }

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = `file-item${item.isDir ? ' dir-item' : ''}`;

    const icon = item.isDir ? '📁' : fileIcon(item.type);
    el.innerHTML = `
      <div class="file-item-name">${icon} ${escapeHtml(item.name)}</div>
      <div class="file-item-meta">${item.sizeHuman || ''} ${item.modified ? '· ' + new Date(item.modified).toLocaleDateString('es-MX') : ''}</div>
      ${!item.isDir ? `<div class="file-item-actions">
        <button class="act-preview">👁️ Ver</button>
        <button class="act-download">⬇️</button>
        <button class="act-share">🔗</button>
        <button class="act-send">💬</button>
        <button class="act-delete">🗑️</button>
      </div>` : ''}
    `;

    if (item.isDir) {
      el.addEventListener('click', () => loadFiles(item.path));
    } else {
      el.querySelector('.act-preview')?.addEventListener('click', () => previewFile(item));
      el.querySelector('.act-download')?.addEventListener('click', () => downloadFile(item));
      el.querySelector('.act-share')?.addEventListener('click', () => shareFile(item));
      el.querySelector('.act-send')?.addEventListener('click', () => {
        inputEl.value = `Analiza el archivo en: ${item.path}`;
        autoResizeTextarea();
        inputEl.focus();
      });
      el.querySelector('.act-delete')?.addEventListener('click', () => deleteFile(item));
    }

    filesList.appendChild(el);
  });
}

function fileIcon(type) {
  return { image: '🖼️', pdf: '📄', audio: '🎵', video: '🎬', text: '📝', dir: '📁' }[type] || '📎';
}

async function previewFile(item) {
  previewTitle.textContent = item.name;
  previewBody.innerHTML = '<div class="loading-msg">Cargando...</div>';
  previewModal.classList.remove('hidden');

  const token = getToken();
  const authQ = token ? `?token=${encodeURIComponent(token)}` : '';

  if (item.type === 'image') {
    previewBody.innerHTML = `<img src="/api/files/inline?path=${encodeURIComponent(item.path)}&token=${encodeURIComponent(token)}" alt="${escapeHtml(item.name)}">`;
  } else if (item.type === 'pdf') {
    previewBody.innerHTML = `<iframe src="/api/files/inline?path=${encodeURIComponent(item.path)}&token=${encodeURIComponent(token)}"></iframe>`;
  } else if (item.type === 'text') {
    try {
      const res = await fetch(`/api/files/content?path=${encodeURIComponent(item.path)}`, { headers: authHeaders() });
      const text = await res.text();
      const ext = (item.ext || '').slice(1);
      previewBody.innerHTML = `<pre><code class="language-${ext}">${escapeHtml(text)}</code></pre>`;
      if (window.Prism) Prism.highlightAllUnder(previewBody);
    } catch { previewBody.innerHTML = '<div class="loading-msg">Error cargando</div>'; }
  } else if (item.type === 'audio') {
    previewBody.innerHTML = `<audio controls src="/api/files/inline?path=${encodeURIComponent(item.path)}&token=${encodeURIComponent(token)}" style="width:100%"></audio>`;
  } else {
    previewBody.innerHTML = `<div class="loading-msg">No hay preview disponible para este tipo de archivo.<br><br><button onclick="downloadFile(${JSON.stringify(item).replace(/"/g,'&quot;')})">⬇️ Descargar</button></div>`;
  }

  $('preview-download').onclick = () => downloadFile(item);
  $('preview-share').onclick = () => shareFile(item);
}

function downloadFile(item) {
  const token = getToken();
  const a = document.createElement('a');
  a.href = `/api/files/download?path=${encodeURIComponent(item.path)}${token ? '&token=' + encodeURIComponent(token) : ''}`;
  a.download = item.name;
  a.click();
}

async function shareFile(item) {
  try {
    const res = await fetch(`/api/files/share?path=${encodeURIComponent(item.path)}`, { headers: authHeaders() });
    const data = await res.json();
    const url = `${location.origin}${data.url}`;
    await navigator.clipboard.writeText(url);
    showToast('Link copiado (válido 1 hora)', 'success');
  } catch {
    showToast('Error generando link', 'error');
  }
}

async function deleteFile(item) {
  if (!confirm(`¿Eliminar "${item.name}"?`)) return;
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(item.path)}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    if (res.ok) { showToast('Eliminado', 'success'); loadFiles(currentDir); }
    else showToast('Error eliminando', 'error');
  } catch { showToast('Error eliminando', 'error'); }
}

// ── FOLDER TABS ───────────────────────────────────────────────
document.querySelectorAll('.folder-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.folder-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadFiles(btn.dataset.dir);
  });
});

// ── HEADER BUTTONS ───────────────────────────────────────────
$('files-toggle').addEventListener('click', () => {
  filesSidebar.classList.toggle('hidden');
});
$('sidebar-close').addEventListener('click', () => {
  filesSidebar.classList.add('hidden');
});

$('search-btn').addEventListener('click', () => {
  searchBar.classList.toggle('hidden');
  if (!searchBar.classList.contains('hidden')) searchInput.focus();
});
$('search-close').addEventListener('click', () => {
  searchBar.classList.add('hidden');
  searchInput.value = '';
  loadHistory(); // restaurar
});
searchInput.addEventListener('input', debounce(() => {
  const q = searchInput.value.trim();
  if (q.length > 1) loadHistory(null, q);
  else if (!q) loadHistory();
}, 400));

$('theme-btn').addEventListener('click', () => {
  document.body.classList.toggle('light');
  $('theme-btn').textContent = document.body.classList.contains('light') ? '🌚' : '🌙';
  localStorage.setItem('theme', document.body.classList.contains('light') ? 'light' : 'dark');
});

$('settings-btn').addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
  updateSettingsPanel();
});
$('settings-close').addEventListener('click', () => settingsModal.classList.add('hidden'));
$('settings-backdrop').addEventListener('click', () => settingsModal.classList.add('hidden'));

$('preview-close').addEventListener('click', () => previewModal.classList.add('hidden'));
$('preview-backdrop').addEventListener('click', () => previewModal.classList.add('hidden'));

// ── SETTINGS PANEL ────────────────────────────────────────────
async function updateSettingsPanel() {
  try {
    const res = await fetch('/api/queue', { headers: authHeaders() });
    const q = await res.json();
    $('queue-status-display').textContent = `${q.size}/${q.maxSize} (busy: ${q.busy})`;
  } catch {}
  try {
    const res = await fetch('/health');
    const h = await res.json();
    $('session-uuid-display').textContent = h.session || '(sin sesión)';
  } catch {}
}

$('sound-toggle').addEventListener('change', e => { soundEnabled = e.target.checked; });

$('export-chat-btn').addEventListener('click', async e => {
  e.preventDefault();
  try {
    const res = await fetch('/api/history?limit=1000', { headers: authHeaders() });
    const msgs = await res.json();
    const md = msgs.map(m => `**[${m.channel}] ${m.role}** — ${new Date(m.created_at).toLocaleString('es-MX')}\n\n${m.content}`).join('\n\n---\n\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `claudeclaw-${new Date().toISOString().slice(0,10)}.md`;
    a.click();
  } catch { showToast('Error exportando', 'error'); }
});

$('starred-btn').addEventListener('click', async e => {
  e.preventDefault();
  settingsModal.classList.add('hidden');
  const res = await fetch('/api/history?starred=1&limit=100', { headers: authHeaders() });
  const msgs = await res.json();
  chatEl.innerHTML = '';
  msgs.forEach(m => appendMessage(m));
  showToast(`${msgs.length} mensajes guardados`);
});

// ── STATUS POLLER ─────────────────────────────────────────────
function setupStatusPoller() {
  // Polling de respaldo si WS inactivo (cada 30s)
  setInterval(async () => {
    if (ws?.readyState === WebSocket.OPEN) return;
    try {
      const res = await fetch('/api/queue', { headers: authHeaders() });
      if (res.ok) setStatus('connecting');
    } catch { setStatus('offline'); }
  }, 30_000);
}

// ── SONIDO ────────────────────────────────────────────────────
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch {}
}

// ── TOAST ─────────────────────────────────────────────────────
function showToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast${type ? ' toast-' + type : ''}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    searchBar.classList.remove('hidden');
    searchInput.focus();
  }
  if (e.key === 'Escape') {
    previewModal.classList.add('hidden');
    settingsModal.classList.add('hidden');
    searchBar.classList.add('hidden');
    slashPopup.classList.add('hidden');
  }
});

// ── LOGIN FORM ────────────────────────────────────────────────
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const password = $('password-input').value;
  const ok = await tryLogin(password);
  if (ok) {
    showApp();
  } else {
    $('login-error').classList.remove('hidden');
    $('password-input').value = '';
  }
});

// ── UTILS ─────────────────────────────────────────────────────
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── THEME RESTORE ─────────────────────────────────────────────
if (localStorage.getItem('theme') === 'light') {
  document.body.classList.add('light');
  $('theme-btn').textContent = '🌚';
}

// ── SERVICE WORKER ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── ARRANCAR ──────────────────────────────────────────────────
init();
