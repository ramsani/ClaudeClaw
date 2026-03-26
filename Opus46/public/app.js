/* ClaudeClaw PWA — app.js */
'use strict';

// ── CONFIGURACIÓN ──────────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/nota',       desc: 'Guardar nota en Nova  →  /nota Título' },
  { cmd: '/accion',     desc: 'Crear acción en Nova  →  /accion Título' },
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
const renderedUuids = new Set();

// ── WORKSPACES ────────────────────────────────────────────────
let workspaceList = [];
let activeWorkspaceId = localStorage.getItem('active_workspace') || 'myclaw';
const scrollPositions = {};

// ── INPUT HISTORY (↑↓ como terminal) ─────────────────────────
const inputHistory = [];
let inputHistoryIdx = -1;
let inputDraftSaved = '';

// ── TAB BADGE ─────────────────────────────────────────────────
let unreadCount = 0;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    unreadCount = 0;
    document.title = 'NovaClaw';
    if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
  }
});

function getActiveWorkspace() {
  return workspaceList.find(w => w.id === activeWorkspaceId) || { id: 'myclaw', name: 'MyClaw', color: '#007AFF' };
}

function setActiveWorkspace(id, isArchived = false) {
  // Guardar scroll del workspace actual antes de cambiar
  if (activeWorkspaceId && chatEl) scrollPositions[activeWorkspaceId] = chatEl.scrollTop;

  activeWorkspaceId = id;
  localStorage.setItem('active_workspace', id);
  updateWorkspaceUI();
  chatEl.innerHTML = '';
  renderedUuids.clear();
  historyBeforeTs = null;

  // Actualizar chat header
  const ws = workspaceList.find(w => w.id === id) || { name: 'MyClaw', color: '#007AFF' };
  const dot = document.getElementById('active-ws-dot');
  const nameEl = document.getElementById('active-ws-name');
  if (dot) dot.style.background = ws.color || '#007AFF';
  if (nameEl) nameEl.textContent = ws.name || 'MyClaw';
  // Mobile header indicator
  const mobileDot = document.getElementById('mobile-ws-dot');
  const mobileName = document.getElementById('mobile-ws-name');
  if (mobileDot) mobileDot.style.background = ws.color || '#007AFF';
  if (mobileName) mobileName.textContent = ws.name || 'MyClaw';
  // Collapsed expand button dot
  const expandDot = document.getElementById('expand-ws-dot');
  if (expandDot) expandDot.style.background = ws.color || '#007AFF';

  // Restaurar scroll tras cargar historial
  loadHistory().then(() => {
    setTimeout(() => {
      const saved = scrollPositions[id];
      chatEl.scrollTop = saved != null ? saved : chatEl.scrollHeight;
    }, 80);
  });
  // Modo lectura para archivados
  const inputArea = document.getElementById('input-area');
  const readonlyBanner = document.getElementById('readonly-banner');
  if (isArchived) {
    if (inputArea) inputArea.style.display = 'none';
    if (!readonlyBanner) {
      const banner = document.createElement('div');
      banner.id = 'readonly-banner';
      banner.className = 'readonly-banner';
      banner.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Sesión archivada — solo lectura
      `;
      document.getElementById('chat-main')?.appendChild(banner);
    }
  } else {
    if (inputArea) inputArea.style.display = '';
    readonlyBanner?.remove();
  }
  const emptyState = document.getElementById('empty-state');
  if (emptyState) chatEl.appendChild(emptyState);
}

async function loadWorkspaces() {
  try {
    const [resActive, resArchived] = await Promise.all([
      fetch('/api/workspaces', { headers: authHeaders() }),
      fetch('/api/workspaces/archived', { headers: authHeaders() }),
    ]);
    if (!resActive.ok) return;
    workspaceList = await resActive.json();
    const archived = resArchived.ok ? await resArchived.json() : [];
    // Ensure activeWorkspaceId is valid (active OR archived)
    const allIds = [...workspaceList, ...archived].map(w => w.id);
    if (!allIds.includes(activeWorkspaceId)) {
      activeWorkspaceId = 'myclaw';
      localStorage.setItem('active_workspace', 'myclaw');
    }
    renderWorkspaceList(archived);
    updateWorkspaceUI();
    // Restaurar modo lectura si el workspace activo es archivado
    const isArchived = archived.some(w => w.id === activeWorkspaceId);
    const inputArea = document.getElementById('input-area');
    if (isArchived && inputArea) inputArea.style.display = 'none';
  } catch {}
}

let _archivedWorkspaces = [];

function renderWorkspaceList(archived = []) {
  _archivedWorkspaces = archived;
  const container = document.getElementById('workspace-list');
  if (!container) return;
  container.innerHTML = '';

  // Activos
  for (const ws of workspaceList) {
    container.appendChild(buildWorkspaceItem(ws, false));
  }

  // El botón añadir está en el header del panel (#ws-new-btn), no aquí

  // Archivados (colapsados por defecto)
  if (archived.length > 0) {
    const hasArchivedActive = archived.some(w => w.id === activeWorkspaceId);
    const toggle = document.createElement('div');
    toggle.className = 'ws-archive-toggle';
    toggle.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg> Archivados (${archived.length})`;
    const archiveList = document.createElement('div');
    archiveList.className = 'ws-archive-list';
    let open = hasArchivedActive; // abrir si el activo es archivado
    archiveList.style.display = open ? 'flex' : 'none';
    toggle.classList.toggle('open', open);
    toggle.addEventListener('click', () => {
      open = !open;
      archiveList.style.display = open ? 'flex' : 'none';
      toggle.classList.toggle('open', open);
    });
    for (const ws of archived) {
      archiveList.appendChild(buildWorkspaceItem(ws, true));
    }
    container.appendChild(toggle);
    container.appendChild(archiveList);
  }
}

function buildWorkspaceItem(ws, isArchived) {
  const item = document.createElement('div');
  item.className = `workspace-item${ws.id === activeWorkspaceId ? ' active' : ''}${isArchived ? ' archived' : ''}`;
  item.dataset.id = ws.id;
  const preview = isArchived && ws.description
    ? `<span class="ws-preview">${ws.description.slice(0, 60)}</span>`
    : '';
  item.innerHTML = `
    <span class="ws-dot" style="background:${isArchived ? '#999' : (ws.color || '#007AFF')}"></span>
    <span class="ws-name-wrap">
      <span class="ws-name">${ws.name}</span>
      ${preview}
    </span>
    ${ws.queue?.busy ? '<span class="ws-busy-dot"></span>' : ''}
  `;
  item.addEventListener('click', () => setActiveWorkspace(ws.id, isArchived));
  return item;
}

function updateWorkspaceUI() {
  const ws = getActiveWorkspace();
  // Header badge
  const badge = document.getElementById('workspace-badge');
  if (badge) {
    badge.textContent = ws.name;
    badge.style.background = ws.color + '22';
    badge.style.color = ws.color;
  }
  // Highlight active in list
  document.querySelectorAll('.workspace-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === activeWorkspaceId);
  });
}

function showAddWorkspaceModal() {
  const modal = document.getElementById('workspace-modal');
  const nameEl  = document.getElementById('ws-name');
  const pathEl  = document.getElementById('ws-path');
  const colorEl = document.getElementById('ws-color');
  const errEl   = document.getElementById('ws-modal-error');
  const submitBtn = document.getElementById('ws-modal-submit');

  // Reset
  nameEl.value = '';
  pathEl.value = '';
  colorEl.value = '#007AFF';
  errEl.classList.add('hidden');
  errEl.textContent = '';

  modal.classList.remove('hidden');
  setTimeout(() => nameEl.focus(), 50);

  // Color presets
  modal.querySelectorAll('.ws-color-preset').forEach(btn => {
    btn.onclick = () => { colorEl.value = btn.dataset.color; };
  });

  // Browse button
  document.getElementById('ws-browse-btn').onclick = (e) => {
    e.stopPropagation();
    const currentVal = pathEl.value.trim() || null;
    showDirPicker(currentVal);
  };

  // Close handlers
  const close = () => {
    modal.classList.add('hidden');
    document.getElementById('dir-picker')?.classList.add('hidden');
  };
  document.getElementById('workspace-backdrop').onclick = close;
  document.getElementById('workspace-modal-close').onclick = close;

  // Submit
  submitBtn.onclick = async () => {
    const name  = nameEl.value.trim();
    const wsPath = pathEl.value.trim();
    const color = colorEl.value;

    if (!name || !wsPath) {
      errEl.textContent = 'Nombre y carpeta son obligatorios';
      errEl.classList.remove('hidden');
      return;
    }

    // Generar ID desde el nombre
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ws-' + Date.now();

    submitBtn.disabled = true;
    submitBtn.textContent = 'Abriendo…';

    try {
      const r = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id, name, path: wsPath, color }),
      });
      const data = await r.json();
      if (r.ok) {
        close();
        showToast(`Sesión "${name}" abierta`, 'success');
        await loadWorkspaces();
        setActiveWorkspace(id, false);
      } else {
        errEl.textContent = data.error || 'Error al abrir sesión';
        errEl.classList.remove('hidden');
      }
    } catch {
      errEl.textContent = 'Error de conexión';
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Abrir sesión';
    }
  };

  // Enter en los campos
  [nameEl, pathEl].forEach(el => {
    el.onkeydown = e => { if (e.key === 'Enter') submitBtn.click(); };
  });
}

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
const mascotThink   = $('mascot-thinking');  // removed in new HTML, kept for compat
const mascotIcon    = $('mascot-icon');        // removed in new HTML, kept for compat
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
async function tryLogin(username, password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
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
  loadWorkspaces().then(() => {
    loadHistory();
    // Inicializar chat header con workspace por defecto
    const ws = workspaceList.find(w => w.id === activeWorkspaceId) || { name: 'MyClaw', color: '#007AFF' };
    const dot = document.getElementById('active-ws-dot');
    const nameEl = document.getElementById('active-ws-name');
    if (dot) dot.style.background = ws.color || '#007AFF';
    if (nameEl) nameEl.textContent = ws.name || 'MyClaw';
  });
  loadFiles();
  loadRecentNotes();
  setupStatusPoller();
  document.getElementById('ws-new-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    showAddWorkspaceModal();
  });
  document.getElementById('notes-refresh-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    loadRecentNotes();
  });
  document.getElementById('split-btn')?.addEventListener('click', toggleSplitView);
  initCollapsiblePanels();
  // Sonido: leer estado guardado
  soundEnabled = localStorage.getItem('sound_enabled') === '1';
  const toggle = document.getElementById('sound-toggle');
  if (toggle) toggle.checked = soundEnabled;
  // Actualizar timestamps relativos cada 60s
  setInterval(() => {
    document.querySelectorAll('time.msg-time[datetime]').forEach(el => {
      el.textContent = relativeTime(el.getAttribute('datetime'));
    });
  }, 60_000);
}

function initCollapsiblePanels() {
  ['sessions', 'files', 'notes'].forEach(id => {
    const panel = document.getElementById('panel-' + id);
    if (!panel) return;
    if (localStorage.getItem('panel-collapsed-' + id) === '1') {
      panel.classList.add('collapsed');
    }
    panel.querySelector('.panel-toggle')?.addEventListener('click', e => {
      if (e.target.closest('.sidebar-panel-action')) return;
      const collapsed = panel.classList.toggle('collapsed');
      localStorage.setItem('panel-collapsed-' + id, collapsed ? '1' : '0');
    });
  });
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
  // Solo mostrar eventos del workspace activo (excepto errores globales)
  if (ev.workspace_id && ev.workspace_id !== activeWorkspaceId && ev.type !== 'error') {
    // Actualizar indicador de actividad en el sidebar
    updateWorkspaceBusyDot(ev.workspace_id, ev.type === 'typing' ? ev.active : null);
    return;
  }
  switch (ev.type) {
    case 'message':
      appendMessage(ev);
      if (ev.role === 'user') scrollToBottom();
      if (ev.role === 'assistant') {
        if (soundEnabled) playChime();
        // Tab badge cuando la ventana está oculta
        if (document.hidden) {
          unreadCount++;
          document.title = `(${unreadCount}) NovaClaw`;
          if ('setAppBadge' in navigator) navigator.setAppBadge(unreadCount).catch(() => {});
        }
      }
      break;
    case 'typing':
      if (ev.active) {
        chatEl.appendChild(typingEl);
        typingEl.classList.remove('hidden');
      } else {
        typingEl.classList.add('hidden');
      }
      updateWorkspaceBusyDot(ev.workspace_id || activeWorkspaceId, ev.active);
      break;
    case 'thinking':
      chatEl.appendChild(typingEl);
      typingEl.classList.remove('hidden');
      break;
    case 'error':
      handleWSError(ev);
      break;
  }
}

function updateWorkspaceBusyDot(wsId, busy) {
  const item = document.querySelector(`.workspace-item[data-id="${wsId}"]`);
  if (!item) return;
  let dot = item.querySelector('.ws-busy-dot');
  if (busy && !dot) {
    dot = document.createElement('span');
    dot.className = 'ws-busy-dot';
    item.appendChild(dot);
  } else if (!busy && dot) {
    dot.remove();
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
  const label = { online: 'Conectado', offline: 'Desconectado', connecting: 'Conectando...' }[s] || s;
  [statusDot, $('status-dot-desktop')].forEach(dot => {
    if (!dot) return;
    dot.className = `status-dot ${s}`;
    dot.title = label;
  });
}

// ── HISTORIAL ─────────────────────────────────────────────────
async function loadHistory(before = null, search = null) {
  if (loadingHistory) return;
  loadingHistory = true;
  try {
    let url = `/api/history?limit=40&workspace_id=${encodeURIComponent(activeWorkspaceId)}`;
    if (before) url += `&before=${before}`;
    if (search) url += `&q=${encodeURIComponent(search)}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return;
    const msgs = await res.json(); // llega en orden DESC (más nuevo primero)

    if (!before) {
      // Carga inicial: invertir para tener ASC (más antiguo primero) y append normal
      chatEl.innerHTML = '';
      renderedUuids.clear();
      if (msgs.length === 0) {
        // Mostrar empty state
        const es = document.getElementById('empty-state');
        if (es) chatEl.appendChild(es);
      } else {
        msgs.slice().reverse().forEach(m => appendMessage(m, false));
      }
      // historyBeforeTs = timestamp del más antiguo cargado (último en DESC = index final)
      historyBeforeTs = msgs.length > 0 ? msgs[msgs.length - 1].created_at : null;
      if (msgs.length > 0) scrollToBottom();
    } else {
      if (msgs.length === 0) {
        historyBeforeTs = null; // no hay más historial
      } else {
        msgs.forEach(m => appendMessage(m, true)); // prepend en orden DESC = resultado correcto
        historyBeforeTs = msgs[msgs.length - 1].created_at; // más antiguo del batch
      }
    }
  } catch {}
  loadingHistory = false;
}

// ── RENDERIZAR MENSAJES ───────────────────────────────────────
function appendMessage(msg, prepend = false) {
  // Evitar duplicados (el mismo mensaje puede llegar por WS e historial)
  if (msg.uuid) {
    if (renderedUuids.has(msg.uuid)) return;
    renderedUuids.add(msg.uuid);
  }
  // Ocultar empty state al primer mensaje
  const emptyState = document.getElementById('empty-state');
  if (emptyState) emptyState.remove();

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
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(pre.textContent.trim());
          btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
          setTimeout(() => { btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'; }, 2000);
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
  const tsDate = msg.created_at ? new Date(msg.created_at) : null;
  const tsAbsolute = tsDate && !isNaN(tsDate) ? tsDate.toLocaleString('es-MX') : '';
  const tsRel = msg.created_at ? relativeTime(msg.created_at) : '';
  meta.innerHTML = `<time class="msg-time" datetime="${msg.created_at || ''}" title="${tsAbsolute}">${tsRel}</time>`;
  if (msg.channel && msg.channel !== 'pwa') {
    const badge = document.createElement('span');
    badge.className = 'channel-badge';
    badge.textContent = msg.channel === 'telegram' ? 'tg' : msg.channel;
    meta.appendChild(badge);
  }
  if (msg.starred) {
    const star = document.createElement('span');
    star.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="#FF9F0A" stroke="#FF9F0A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
    meta.appendChild(star);
  }

  // Acciones en hover
  const actions = document.createElement('div');
  actions.className = 'bubble-actions';
  const svgCopy = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
  const svgStarFill = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  const svgStar = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  const svgNote = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
  const svgCheck = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const svgReturn = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>';
  actions.innerHTML = `
    <button class="act-copy">${svgCopy} Copiar</button>
    <button class="act-star">${msg.starred ? svgStarFill + ' Guardado' : svgStar + ' Guardar'}</button>
    ${msg.role === 'assistant' ? `<button class="act-nova-note">${svgNote} Nota</button>` : ''}
    ${msg.role === 'assistant' ? `<button class="act-nova-action">${svgCheck} Acción</button>` : ''}
    ${msg.role === 'assistant' ? `<button class="act-continue">${svgReturn} Continuar</button>` : ''}
  `;
  actions.querySelector('.act-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(msg.content || '');
    showToast('Copiado', 'success');
  });
  actions.querySelector('.act-star').addEventListener('click', async (e) => {
    const starred = !msg.starred;
    msg.starred = starred;
    e.target.innerHTML = starred ? svgStarFill + ' Guardado' : svgStar + ' Guardar';
    await fetch(`/api/messages/${msg.uuid}/star`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ starred }),
    });
  });
  const noteBtn = actions.querySelector('.act-nova-note');
  if (noteBtn) {
    noteBtn.addEventListener('click', async (e) => {
      e.target.innerHTML = svgCheck + ' Guardando…';
      await saveToNova('nota', extractTitle(msg.content || ''), msg.content || '');
      e.target.innerHTML = svgNote + ' Nota';
    });
  }
  const actionBtn = actions.querySelector('.act-nova-action');
  if (actionBtn) {
    actionBtn.addEventListener('click', async (e) => {
      e.target.innerHTML = svgCheck + ' Guardando…';
      await saveToNova('accion', extractTitle(msg.content || ''), msg.content || '');
      e.target.innerHTML = svgCheck + ' Acción';
    });
  }
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
    cb.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg> Continuar respuesta';
    cb.addEventListener('click', () => { cb.remove(); sendMessage('continúa donde te quedaste'); });
    row.appendChild(cb);
  }

  // Click en el bubble → mostrar/ocultar acciones (cierra los demás)
  bubble.addEventListener('click', (e) => {
    if (e.target.closest('button, a, code, pre')) return; // no interferir con botones/links
    const isOpen = row.classList.contains('actions-open');
    chatEl.querySelectorAll('.msg-row.actions-open').forEach(r => r.classList.remove('actions-open'));
    if (!isOpen) row.classList.add('actions-open');
  });

  const wasAtBottom = isAtBottom();
  if (prepend) {
    chatEl.insertBefore(row, chatEl.firstChild);
  } else {
    // Insertar antes del typing indicator si está visible
    const typing = document.getElementById('typing-indicator');
    if (typing && typing.parentNode === chatEl) {
      chatEl.insertBefore(row, typing);
    } else {
      chatEl.appendChild(row);
    }
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

// ── SELECTION TOOLBAR ─────────────────────────────────────────
(function initSelectionToolbar() {
  const toolbar = document.createElement('div');
  toolbar.id = 'selection-toolbar';
  toolbar.className = 'selection-toolbar hidden';
  toolbar.innerHTML = `
    <button data-action="copy" title="Copiar">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      Copiar
    </button>
    <button data-action="ask" title="Preguntar sobre esto">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Preguntar
    </button>
    <button data-action="nota" title="Guardar nota en Nova">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
      Nota
    </button>
    <button data-action="accion" title="Crear acción en Nova">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      Acción
    </button>
    <button data-action="buscar" title="Buscar en historial">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      Buscar
    </button>
  `;
  document.body.appendChild(toolbar);

  let selectedText = '';
  let hideTimer = null;

  function showToolbar(x, y, text) {
    selectedText = text;
    clearTimeout(hideTimer);
    // Posición sobre la selección
    const tw = 320, th = 40;
    let left = x - tw / 2;
    let top  = y - th - 10;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    top  = top < 8 ? y + 16 : top;
    toolbar.style.left = left + 'px';
    toolbar.style.top  = top  + 'px';
    toolbar.classList.remove('hidden');
  }

  function hideToolbar() {
    hideTimer = setTimeout(() => toolbar.classList.add('hidden'), 150);
  }

  // Mostrar al soltar el mouse sobre un bubble del chat
  document.addEventListener('mouseup', e => {
    // Solo si el mouseup ocurre dentro del chat
    if (!e.target.closest('#chat')) return hideToolbar();
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text || text.length < 3) return hideToolbar();
      // Solo dentro de burbujas
      const anchor = sel.anchorNode?.parentElement?.closest('.bubble');
      if (!anchor) return hideToolbar();
      const range = sel.getRangeAt(0).getBoundingClientRect();
      showToolbar(range.left + range.width / 2, range.top + window.scrollY, text);
    }, 10);
  });

  // Ocultar al hacer click fuera
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#selection-toolbar')) hideToolbar();
  });

  // Touch: mostrar después de selección táctil
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 3) return;
    const anchor = sel.anchorNode?.parentElement?.closest('.bubble');
    if (!anchor) return;
    // En touch, posicionar en centro de pantalla
    if (window.matchMedia('(pointer: coarse)').matches) {
      showToolbar(window.innerWidth / 2, 80, text);
    }
  });

  // Acciones
  toolbar.addEventListener('mousedown', e => e.preventDefault()); // no perder selección
  toolbar.addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const text = selectedText;
    hideToolbar();
    window.getSelection()?.removeAllRanges();

    if (action === 'copy') {
      await navigator.clipboard.writeText(text);
      showToast('Copiado', 'success');
    } else if (action === 'ask') {
      inputEl.value = `Sobre esto: "${text.slice(0, 200)}"\n\n`;
      inputEl.focus();
      // Mover cursor al final
      inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
      if (typeof autoResizeTextarea === 'function') autoResizeTextarea();
    } else if (action === 'nota') {
      const title = text.split('\n')[0].slice(0, 160);
      await saveToNova('nota', title, text);
    } else if (action === 'accion') {
      const title = text.split('\n')[0].slice(0, 160);
      await saveToNova('accion', title, text);
    } else if (action === 'buscar') {
      // Activar búsqueda con el texto seleccionado
      const searchBar = document.getElementById('search-bar');
      const searchInput = document.getElementById('search-input');
      if (searchBar && searchInput) {
        searchBar.classList.remove('hidden');
        searchInput.value = text.slice(0, 60);
        searchInput.focus();
        searchInput.dispatchEvent(new Event('input'));
      }
    }
  });
})();

// ── SCROLL ────────────────────────────────────────────────────
function isAtBottom() {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
}
function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Scroll infinito hacia arriba para cargar más historial
chatEl.addEventListener('scroll', () => {
  if (chatEl.scrollTop < 100 && historyBeforeTs && !loadingHistory) {
    const prevH = chatEl.scrollHeight;
    loadHistory(historyBeforeTs).then(() => {
      const added = chatEl.scrollHeight - prevH;
      if (added > 0) chatEl.scrollTop = added; // mantener posición visual
    });
  }
});

// ── ENVIAR MENSAJE ────────────────────────────────────────────
// ── GUARDAR EN NOVA ───────────────────────────────────────────
function extractTitle(content) {
  // 1. Buscar primer encabezado markdown
  const heading = content.match(/^#{1,3}\s+(.+)/m);
  if (heading) return heading[1].trim().slice(0, 160);

  // 2. Buscar primera línea con contenido real (≥20 chars)
  const lines = content.split('\n').map(l => l.replace(/^[*_`#>\-•\d.]+\s*/, '').trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length >= 20) {
      // Cortar en punto o coma si es muy larga
      const cut = line.length > 120 ? line.slice(0, 120).replace(/[,;]\s*\S+$/, '').replace(/\s+\S+$/, '') + '…' : line;
      return cut;
    }
  }
  return lines[0]?.slice(0, 120) || 'Sin título';
}

async function saveToNova(type, title, content) {
  const endpoint = type === 'nota' ? '/api/nova/note' : '/api/nova/action';
  const body = type === 'nota'
    ? { title, content, note_type: 'general' }
    : { title, content, action_type: 'task' };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('error');
    const label = type === 'nota' ? 'Nota guardada en Nova' : 'Acción creada en Nova';
    showToast(label, 'success');
    loadRecentNotes(); // refrescar panel sidebar
  } catch {
    showToast('Error guardando en Nova', 'error');
  }
}

async function sendMessage(text) {
  const msg = (text || inputEl.value).trim();
  if (!msg) return;

  // Slash commands locales: /nota y /accion
  const notaMatch  = msg.match(/^\/nota\s+(.+)/si);
  const accionMatch = msg.match(/^\/accion\s+(.+)/si);
  if (notaMatch) {
    if (!text) inputEl.value = '';
    autoResizeTextarea();
    await saveToNova('nota', notaMatch[1].split('\n')[0].slice(0, 200), notaMatch[1]);
    return;
  }
  if (accionMatch) {
    if (!text) inputEl.value = '';
    autoResizeTextarea();
    await saveToNova('accion', accionMatch[1].split('\n')[0].slice(0, 200), accionMatch[1]);
    return;
  }

  if (!text) inputEl.value = '';
  autoResizeTextarea();
  // Guardar en historial de input
  inputHistory.unshift(msg);
  if (inputHistory.length > 50) inputHistory.pop();
  inputHistoryIdx = -1;
  inputDraftSaved = '';
  sendBtn.disabled = true;
  scrollToBottom(); // siempre ir al fondo al enviar

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message: msg, workspace_id: activeWorkspaceId }),
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
  // Enter sin Shift → enviar; Shift+Enter → salto de línea
  if (e.key === 'Enter' && !e.shiftKey) {
    if (!slashPopup.classList.contains('hidden')) {
      // handled below
    } else {
      e.preventDefault(); sendMessage(); return;
    }
  }

  // Historial de input con ↑↓ (solo cuando el input está vacío o navegando historial)
  if (e.key === 'ArrowUp' && slashPopup.classList.contains('hidden') && !e.shiftKey) {
    if (inputHistoryIdx === -1) inputDraftSaved = inputEl.value;
    if (inputHistoryIdx < inputHistory.length - 1) {
      inputHistoryIdx++;
      inputEl.value = inputHistory[inputHistoryIdx];
      autoResizeTextarea();
      setTimeout(() => inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length), 0);
      e.preventDefault();
      return;
    }
  }
  if (e.key === 'ArrowDown' && slashPopup.classList.contains('hidden') && inputHistoryIdx >= 0) {
    inputHistoryIdx--;
    inputEl.value = inputHistoryIdx === -1 ? inputDraftSaved : inputHistory[inputHistoryIdx];
    autoResizeTextarea();
    e.preventDefault();
    return;
  }

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
    back.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg> ..`;
    back.addEventListener('click', () => {
      const parent = dir.split('/').slice(0, -1).join('/');
      loadFiles(parent);
    });
    filesList.appendChild(back);
  }

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = `file-item${item.isDir ? ' dir-item' : ''}`;

    const iconSvg = item.isDir ? fileIconSvg('dir') : fileIconSvg(item.type);
    el.innerHTML = `
      <div class="file-item-name">${iconSvg} ${escapeHtml(item.name)}</div>
      <div class="file-item-meta">${item.sizeHuman || ''} ${item.modified ? '· ' + new Date(item.modified).toLocaleDateString('es-MX') : ''}</div>
      ${!item.isDir ? `<div class="file-item-actions">
        <button class="act-preview" title="Ver"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
        <button class="act-download" title="Descargar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
        <button class="act-share" title="Compartir"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>
        <button class="act-send" title="Enviar a Claude"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>
        <button class="act-delete" title="Eliminar"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg></button>
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

function fileIconSvg(type) {
  const icons = {
    image: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    pdf:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    audio: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
    video: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
    text:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    dir:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  };
  return icons[type] || `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
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
    previewBody.innerHTML = `<div class="loading-msg">No hay preview disponible para este tipo de archivo.<br><br><button onclick="downloadFile(${JSON.stringify(item).replace(/"/g,'&quot;')})"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Descargar</button></div>`;
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
  filesSidebar.classList.toggle('mobile-shown');
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

document.querySelectorAll('#theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark' : 'light');
  });
});

// settings-btn wired via querySelectorAll below (supports header + sidebar instances)
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

$('sound-toggle').addEventListener('change', e => {
  soundEnabled = e.target.checked;
  localStorage.setItem('sound_enabled', soundEnabled ? '1' : '0');
});

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

// ── SIDEBAR COLLAPSE / RESIZE ─────────────────────────────────
(function() {
  const sidebar    = $('files-sidebar');
  const collapseBtn = $('sidebar-collapse-btn');
  const expandBtn  = $('sidebar-expand-btn');
  const handle     = $('sidebar-resize-handle');
  if (!sidebar || !collapseBtn) return;

  const STORAGE_KEY_W = 'sidebar-width';
  const STORAGE_KEY_C = 'sidebar-collapsed';

  // Restaurar ancho guardado
  const savedW = localStorage.getItem(STORAGE_KEY_W);
  if (savedW) sidebar.style.width = savedW + 'px';

  // Restaurar estado colapsado
  if (localStorage.getItem(STORAGE_KEY_C) === '1') {
    sidebar.classList.add('collapsed');
    expandBtn?.classList.remove('hidden');
    collapseBtn.style.display = 'none';
  }

  function collapse() {
    sidebar.classList.add('collapsed');
    expandBtn?.classList.remove('hidden');
    collapseBtn.style.display = 'none';
    localStorage.setItem(STORAGE_KEY_C, '1');
  }
  function expand() {
    sidebar.classList.remove('collapsed');
    expandBtn?.classList.add('hidden');
    collapseBtn.style.display = '';
    localStorage.setItem(STORAGE_KEY_C, '0');
  }

  collapseBtn.addEventListener('click', collapse);
  expandBtn?.addEventListener('click', expand);

  // ── Drag to resize ──
  if (!handle) return;
  let startX, startW;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    handle.classList.add('dragging');

    function onMove(e) {
      const newW = Math.min(480, Math.max(160, startW + e.clientX - startX));
      sidebar.style.width = newW + 'px';
    }
    function onUp() {
      handle.classList.remove('dragging');
      localStorage.setItem(STORAGE_KEY_W, sidebar.offsetWidth);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

// Cerrar acciones al hacer click fuera de un mensaje
document.addEventListener('click', e => {
  if (!e.target.closest('.msg-row')) {
    chatEl.querySelectorAll('.msg-row.actions-open').forEach(r => r.classList.remove('actions-open'));
  }
});

// ── KEYBOARD SHORTCUTS ────────────────────────────────────────
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  const inInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

  // Cmd+K — búsqueda (siempre)
  if (mod && e.key === 'k') {
    e.preventDefault();
    searchBar.classList.toggle('hidden');
    if (!searchBar.classList.contains('hidden')) searchInput.focus();
    return;
  }
  // Cmd+N — nueva sesión (no en inputs)
  if (mod && e.key === 'n' && !inInput) {
    e.preventDefault();
    showAddWorkspaceModal();
    return;
  }
  // Cmd+1..9 — saltar a workspace N
  if (mod && !inInput && e.key >= '1' && e.key <= '9') {
    const wsTarget = workspaceList[parseInt(e.key) - 1];
    if (wsTarget) { e.preventDefault(); setActiveWorkspace(wsTarget.id, false); }
  }
  // Escape — cerrar modales y overlays
  if (e.key === 'Escape') {
    previewModal.classList.add('hidden');
    settingsModal.classList.add('hidden');
    searchBar.classList.add('hidden');
    slashPopup.classList.add('hidden');
    document.getElementById('workspace-modal')?.classList.add('hidden');
    document.getElementById('dir-picker')?.classList.add('hidden');
  }
});

// ── LOGIN FORM ────────────────────────────────────────────────
$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('username-input')?.value || '';
  const password = $('password-input').value;
  const ok = await tryLogin(username, password);
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
(function() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.body.classList.add('dark');
  }
})();

// ── SETTINGS / SEARCH — wire desktop sidebar duplicates ───────
const searchBtnDesktop = $('search-btn-desktop');
if (searchBtnDesktop) {
  searchBtnDesktop.addEventListener('click', () => {
    searchBar.classList.toggle('hidden');
    if (!searchBar.classList.contains('hidden')) searchInput.focus();
  });
}

// settings-btn: there may be two (header + sidebar footer) — both wired via querySelectorAll
document.querySelectorAll('#settings-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    updateSettingsPanel();
  });
});

// ── MOBILE TABS ───────────────────────────────────────────────
const mobileTabs = $('mobile-tabs');
if (mobileTabs) {
  mobileTabs.querySelectorAll('.mobile-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      mobileTabs.querySelectorAll('.mobile-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const panel = btn.dataset.panel;
      const chatMain = $('chat-main');

      if (panel === 'chat') {
        chatMain.classList.remove('mobile-hidden');
        filesSidebar.classList.remove('mobile-shown');
      } else {
        chatMain.classList.add('mobile-hidden');
        filesSidebar.classList.add('mobile-shown');
        // Scroll to the relevant panel within the sidebar
        const targetPanel = document.getElementById(
          panel === 'sessions' ? 'panel-sessions' :
          panel === 'files'    ? 'panel-files'    :
          panel === 'notes'    ? 'panel-notes'    : 'panel-sessions'
        );
        if (targetPanel) {
          // Ensure the panel is expanded
          targetPanel.classList.remove('collapsed');
          setTimeout(() => targetPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
        }
      }
    });
  });
}

// ── RELATIVE TIME ─────────────────────────────────────────────
function relativeTime(ts) {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts)) / 1000;
  if (diff < 60) return 'ahora';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  if (diff < 604800) return `hace ${Math.floor(diff / 86400)} d`;
  return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

// ── NOTAS Y ACCIONES RECIENTES ────────────────────────────────
async function loadRecentNotes() {
  const list = document.getElementById('notes-list');
  if (!list) return;
  list.innerHTML = '<div class="loading-msg">Cargando…</div>';
  try {
    const res = await fetch('/api/nova/recent?limit=10', { headers: authHeaders() });
    if (!res.ok) { list.innerHTML = '<div class="loading-msg">Error al cargar</div>'; return; }
    const items = await res.json();
    list.innerHTML = '';
    if (items.length === 0) {
      list.innerHTML = '<div class="loading-msg">Sin notas recientes</div>';
      return;
    }
    items.forEach(item => {
      const el = document.createElement('div');
      el.className = 'note-item';
      el.innerHTML = `
        <div class="note-item-header">
          <span class="note-item-badge ${item.type === 'note' ? 'badge-note' : 'badge-action'}">${item.type === 'note' ? 'Nota' : 'Acción'}</span>
          <span class="note-item-time">${relativeTime(item.created_at)}</span>
        </div>
        <div class="note-item-title">${escapeHtml(item.title || '(sin título)')}</div>
        <div class="note-item-editor hidden">
          <input class="note-edit-title" type="text" value="${escapeHtml(item.title || '')}">
          <textarea class="note-edit-content">${escapeHtml(item.content || '')}</textarea>
          <div class="note-edit-actions">
            <button class="note-save-btn">Guardar</button>
            <button class="note-cancel-btn">Cancelar</button>
          </div>
        </div>`;
      el.querySelector('.note-item-title').addEventListener('click', () => {
        el.querySelector('.note-item-editor').classList.toggle('hidden');
        el.querySelector('.note-edit-title').focus();
      });
      el.querySelector('.note-save-btn').addEventListener('click', async () => {
        const title = el.querySelector('.note-edit-title').value;
        const content = el.querySelector('.note-edit-content').value;
        const r = await fetch(`/api/nova/${item.type}/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ title, content }),
        });
        if (r.ok) {
          el.querySelector('.note-item-title').textContent = title;
          el.querySelector('.note-item-editor').classList.add('hidden');
          showToast('Guardado', 'success');
        } else showToast('Error al guardar', 'error');
      });
      el.querySelector('.note-cancel-btn').addEventListener('click', () => {
        el.querySelector('.note-item-editor').classList.add('hidden');
      });
      list.appendChild(el);
    });
  } catch { list.innerHTML = '<div class="loading-msg">Error de conexión</div>'; }
}

// ── FILE PICKER (dir browser) ─────────────────────────────────
async function showDirPicker(startPath) {
  const picker = document.getElementById('dir-picker');
  const breadcrumb = document.getElementById('dir-picker-breadcrumb');
  const listEl = document.getElementById('dir-picker-list');
  const loading = document.getElementById('dir-picker-loading');
  const errEl = document.getElementById('dir-picker-error');
  const pathInput = document.getElementById('ws-path');
  if (!picker) return;

  picker.classList.remove('hidden');

  async function navigate(p) {
    loading.classList.remove('hidden');
    listEl.innerHTML = '';
    errEl.classList.add('hidden');
    try {
      const res = await fetch(`/api/files/ls?path=${encodeURIComponent(p)}`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'error');

      // Breadcrumb
      const parts = data.path.split('/').filter(Boolean);
      breadcrumb.innerHTML = parts.map((part, i) => {
        const fp = '/' + parts.slice(0, i + 1).join('/');
        return `<span class="dir-crumb" data-path="${escapeHtml(fp)}">${escapeHtml(part)}</span>`;
      }).join('<span class="dir-sep">/</span>');
      breadcrumb.querySelectorAll('.dir-crumb').forEach(c =>
        c.addEventListener('click', () => navigate(c.dataset.path))
      );

      // Directorio actual — botón de seleccionar
      const curBtn = document.createElement('button');
      curBtn.className = 'dir-picker-select';
      const shortPath = data.path.split('/').slice(-2).join('/');
      curBtn.textContent = `✓ Usar …/${shortPath}`;
      curBtn.onclick = () => { pathInput.value = data.path; picker.classList.add('hidden'); };
      listEl.appendChild(curBtn);

      if (data.dirs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dir-picker-empty';
        empty.textContent = 'Sin subdirectorios';
        listEl.appendChild(empty);
      } else {
        data.dirs.forEach(dir => {
          const item = document.createElement('div');
          item.className = 'dir-picker-item';
          item.textContent = '📁 ' + dir.name;
          item.addEventListener('click', () => navigate(dir.path));
          listEl.appendChild(item);
        });
      }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
    loading.classList.add('hidden');
  }

  const initialPath = startPath || (os?.homedir?.() ?? '/Users');
  await navigate(initialPath.startsWith('/') ? initialPath : '/Users');

  // Cerrar al click fuera
  const outsideHandler = (e) => {
    if (!picker.contains(e.target) && e.target.id !== 'ws-browse-btn') {
      picker.classList.add('hidden');
      document.removeEventListener('mousedown', outsideHandler);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', outsideHandler), 0);
}

// ── SPLIT VIEW ────────────────────────────────────────────────
let splitActive = false;
function toggleSplitView() {
  splitActive = !splitActive;
  const views = document.getElementById('workspace-views');
  const chat2 = document.getElementById('chat-main-2');
  if (views && chat2) {
    views.classList.toggle('split-mode', splitActive);
    chat2.classList.toggle('hidden', !splitActive);
    if (splitActive) {
      const sel = document.getElementById('split-ws-selector');
      if (sel) {
        sel.innerHTML = workspaceList
          .filter(w => w.id !== activeWorkspaceId)
          .map(w => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`)
          .join('');
      }
    }
  } else {
    // Split view HTML not yet in DOM — show toast
    showToast('Vista dividida disponible próximamente', 'info');
    splitActive = false;
  }
}

// ── SERVICE WORKER ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── ARRANCAR ──────────────────────────────────────────────────
init();
