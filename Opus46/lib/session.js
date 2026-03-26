'use strict';
const db = require('./db');

const KEY = 'claude_session_uuid';

function loadSession() {
  const uuid = db.stateGet(KEY);
  return uuid || null;
}

function saveSession(uuid) {
  if (uuid) db.stateSet(KEY, uuid);
}

function clearSession() {
  db.stateSet(KEY, '');
}

module.exports = { loadSession, saveSession, clearSession };
