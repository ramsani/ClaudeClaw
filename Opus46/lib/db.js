'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const os   = require('os');

const WORK_DIR = process.env.WORK_DIR || path.join(os.homedir(), '0Proyectos', 'MyClaw');
const DB_PATH  = path.join(WORK_DIR, 'claudeclaw.db');

let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid         TEXT    NOT NULL UNIQUE,
      channel      TEXT    NOT NULL,
      role         TEXT    NOT NULL,
      content      TEXT    NOT NULL,
      chat_id      TEXT,
      created_at   INTEGER NOT NULL,
      session_uuid TEXT,
      file_path    TEXT,
      starred      INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_time    ON messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_starred ON messages(starred) WHERE starred = 1;

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint   TEXT    NOT NULL UNIQUE,
      p256dh     TEXT    NOT NULL,
      auth       TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO bridge_state VALUES('claude_session_uuid', '');
    INSERT OR IGNORE INTO bridge_state VALUES('schema_version', '1');
  `);

  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

// ── bridge_state ──────────────────────────────────────────────
function stateGet(key) {
  const row = getDb().prepare('SELECT value FROM bridge_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function stateSet(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO bridge_state(key, value) VALUES(?, ?)').run(key, String(value));
}

// ── messages ──────────────────────────────────────────────────
function insertMessage({ uuid, channel, role, content, chat_id, session_uuid, file_path }) {
  getDb().prepare(`
    INSERT OR IGNORE INTO messages(uuid, channel, role, content, chat_id, created_at, session_uuid, file_path)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuid, channel, role, content, chat_id || null, Date.now(), session_uuid || null, file_path || null);
}

function getHistory({ limit = 50, before = null, q = null, starred = false } = {}) {
  let sql = 'SELECT * FROM messages';
  const params = [];
  const conditions = [];

  if (before != null) { conditions.push('created_at < ?'); params.push(before); }
  if (q)       { conditions.push("content LIKE '%' || ? || '%'"); params.push(q); }
  if (starred) { conditions.push('starred = 1'); }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return getDb().prepare(sql).all(...params).reverse();
}

function starMessage(uuid, value) {
  getDb().prepare('UPDATE messages SET starred = ? WHERE uuid = ?').run(value ? 1 : 0, uuid);
}

function exportMessages() {
  return getDb().prepare('SELECT * FROM messages ORDER BY created_at ASC').all();
}

module.exports = { init, getDb, stateGet, stateSet, insertMessage, getHistory, starMessage, exportMessages };
