'use strict';
/**
 * NovaClaw — PostgreSQL shared with Nova
 * Replaces SQLite lib/db.js
 * Shares: users_registry, notes, actions, projects
 * Owns:   novaclaw_messages, novaclaw_state
 */
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'nova',
  user:     process.env.PG_USER     || 'nova',
  password: process.env.PG_PASSWORD || 'NovaStrong2026',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', err => console.error('[pgdb] pool error:', err.message));

async function init() {
  const client = await pool.connect();
  try {
    // Tabla de mensajes de NovaClaw
    await client.query(`
      CREATE TABLE IF NOT EXISTS novaclaw_messages (
        id               SERIAL PRIMARY KEY,
        uuid             VARCHAR(128) NOT NULL UNIQUE,
        user_id          VARCHAR(80),
        telegram_chat_id VARCHAR(40),
        channel          VARCHAR(40) NOT NULL,
        role             VARCHAR(20) NOT NULL,
        content          TEXT        NOT NULL,
        session_uuid     VARCHAR(128),
        file_path        TEXT,
        starred          BOOLEAN DEFAULT FALSE,
        created_at       BIGINT  NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ncm_time    ON novaclaw_messages(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ncm_user    ON novaclaw_messages(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ncm_starred ON novaclaw_messages(starred) WHERE starred = TRUE;
    `);

    // Tabla de estado (sesión UUID, etc.) por usuario
    await client.query(`
      CREATE TABLE IF NOT EXISTS novaclaw_state (
        key     VARCHAR(128) NOT NULL,
        user_id VARCHAR(80)  NOT NULL DEFAULT '',
        value   TEXT         NOT NULL,
        PRIMARY KEY (key, user_id)
      );
    `);

    // Agregar password_hash a users_registry si no existe
    await client.query(`
      ALTER TABLE users_registry
        ADD COLUMN IF NOT EXISTS password_hash VARCHAR(128),
        ADD COLUMN IF NOT EXISTS novaclaw_active BOOLEAN DEFAULT FALSE;
    `);

    // Tabla de workspaces
    await client.query(`
      CREATE TABLE IF NOT EXISTS novaclaw_workspaces (
        id          VARCHAR(40) PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        path        TEXT NOT NULL,
        color       VARCHAR(20) DEFAULT '#007AFF',
        description TEXT DEFAULT '',
        sort_order  INTEGER DEFAULT 0,
        active      BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // workspace_id en mensajes
    await client.query(`
      ALTER TABLE novaclaw_messages
        ADD COLUMN IF NOT EXISTS workspace_id VARCHAR(40) DEFAULT 'myclaw';
      CREATE INDEX IF NOT EXISTS idx_ncm_ws ON novaclaw_messages(workspace_id, created_at DESC);
    `);

    console.log('[pgdb] PostgreSQL conectado y tablas listas');
  } finally {
    client.release();
  }
}

// ── bridge_state (por usuario) ──────────────────────────────
async function stateGet(key, userId = '') {
  const { rows } = await pool.query(
    'SELECT value FROM novaclaw_state WHERE key=$1 AND user_id=$2',
    [key, userId]
  );
  return rows[0]?.value ?? null;
}

async function stateSet(key, value, userId = '') {
  await pool.query(
    `INSERT INTO novaclaw_state(key, user_id, value) VALUES($1,$2,$3)
     ON CONFLICT (key, user_id) DO UPDATE SET value=EXCLUDED.value`,
    [key, userId, String(value)]
  );
}

// ── mensajes ────────────────────────────────────────────────
async function insertMessage({ uuid, channel, role, content, chat_id, session_uuid, file_path, user_id, workspace_id }) {
  await pool.query(
    `INSERT INTO novaclaw_messages
       (uuid, user_id, telegram_chat_id, channel, role, content, session_uuid, file_path, workspace_id, created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (uuid) DO NOTHING`,
    [uuid, user_id || null, chat_id || null, channel, role, content,
     session_uuid || null, file_path || null, workspace_id || 'myclaw', Date.now()]
  );
}

async function getHistory({ limit = 50, before = null, q = null, starred = false, user_id = null, workspace_id = null } = {}) {
  const safeLimit = Math.min(isFinite(limit) ? limit : 50, 200);
  const conditions = [];
  const params = [];
  let i = 1;

  if (workspace_id) { conditions.push(`workspace_id = $${i++}`);  params.push(workspace_id); }
  if (user_id)      { conditions.push(`user_id = $${i++}`);       params.push(user_id); }
  if (before != null) { conditions.push(`created_at < $${i++}`);  params.push(before); }
  if (q)            { conditions.push(`content ILIKE $${i++}`);   params.push(`%${q}%`); }
  if (starred)      { conditions.push(`starred = TRUE`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(safeLimit);

  const { rows } = await pool.query(
    `SELECT * FROM novaclaw_messages ${where}
     ORDER BY created_at DESC LIMIT $${i}`,
    params
  );
  return rows.reverse();
}

async function starMessage(uuid, value) {
  await pool.query(
    'UPDATE novaclaw_messages SET starred=$1 WHERE uuid=$2',
    [value ? true : false, uuid]
  );
}

async function exportMessages(user_id = null) {
  const where = user_id ? 'WHERE user_id=$1' : '';
  const params = user_id ? [user_id] : [];
  const { rows } = await pool.query(
    `SELECT * FROM novaclaw_messages ${where} ORDER BY created_at ASC`,
    params
  );
  return rows;
}

// ── users (multi-usuario) ───────────────────────────────────
async function getUserByTelegramChatId(chatId) {
  const { rows } = await pool.query(
    `SELECT * FROM users_registry WHERE telegram_chat_id=$1 AND active=TRUE LIMIT 1`,
    [String(chatId)]
  );
  return rows[0] || null;
}

async function getUserByUserId(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM users_registry WHERE user_id=$1 AND active=TRUE LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function verifyUserPassword(userId, password) {
  const user = await getUserByUserId(userId);
  if (!user || !user.password_hash) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  return ok ? user : null;
}

async function setUserPassword(userId, password) {
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `UPDATE users_registry SET password_hash=$1, novaclaw_active=TRUE WHERE user_id=$2`,
    [hash, userId]
  );
}

// ── workspaces ──────────────────────────────────────────────
async function getWorkspaces() {
  const { rows } = await pool.query(
    `SELECT * FROM novaclaw_workspaces WHERE active=TRUE ORDER BY sort_order ASC, created_at ASC`
  );
  return rows;
}

async function upsertWorkspace({ id, name, path: wsPath, color, description, sort_order }) {
  await pool.query(
    `INSERT INTO novaclaw_workspaces(id, name, path, color, description, sort_order)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, path=EXCLUDED.path,
       color=EXCLUDED.color, description=EXCLUDED.description, sort_order=EXCLUDED.sort_order`,
    [id, name, wsPath, color || '#007AFF', description || '', sort_order || 0]
  );
}

async function deleteWorkspace(id) {
  await pool.query(`UPDATE novaclaw_workspaces SET active=FALSE WHERE id=$1`, [id]);
}

// ── notas (shared con Nova) ─────────────────────────────────
async function getNotes({ user_id, limit = 20 } = {}) {
  const where = user_id ? 'WHERE user_id=$1' : '';
  const params = user_id ? [user_id, limit] : [limit];
  const idx = user_id ? '$2' : '$1';
  const { rows } = await pool.query(
    `SELECT * FROM notes ${where} ORDER BY created_at DESC LIMIT ${idx}`,
    params
  );
  return rows;
}

async function createNote({ user_id, telegram_chat_id, title, content, note_type = 'general' }) {
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO notes(user_id, telegram_chat_id, title, content, note_type, created_at, updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [user_id, telegram_chat_id || null, title || '', content, note_type, now, now]
  );
  return rows[0];
}

// ── acciones (shared con Nova) ──────────────────────────────
async function getActions({ user_id, status = null, limit = 20 } = {}) {
  const conditions = [];
  const params = [];
  if (user_id) { conditions.push(`user_id=$${params.length + 1}`); params.push(user_id); }
  if (status)  { conditions.push(`status=$${params.length + 1}`);   params.push(status); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT * FROM actions ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function createAction({ user_id, telegram_chat_id, title, content, action_type = 'task', due_at = null }) {
  const now = new Date().toISOString();
  const { rows } = await pool.query(
    `INSERT INTO actions(user_id, telegram_chat_id, title, content, action_type, status, due_at, created_at, updated_at)
     VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8) RETURNING *`,
    [user_id, telegram_chat_id || null, title || '', content || '', action_type, due_at || null, now, now]
  );
  return rows[0];
}

module.exports = {
  pool, init,
  stateGet, stateSet,
  insertMessage, getHistory, starMessage, exportMessages,
  getUserByTelegramChatId, getUserByUserId, verifyUserPassword, setUserPassword,
  getWorkspaces, upsertWorkspace, deleteWorkspace,
  getNotes, createNote, getActions, createAction,
};
