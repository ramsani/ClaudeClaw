'use strict';
const pgdb = require('./pgdb');

const KEY = 'claude_session_uuid';

async function loadSession(userId = '') {
  const uuid = await pgdb.stateGet(KEY, userId);
  return uuid || null;
}

async function saveSession(uuid, userId = '') {
  if (uuid) await pgdb.stateSet(KEY, uuid, userId);
}

async function clearSession(userId = '') {
  await pgdb.stateSet(KEY, '', userId);
}

module.exports = { loadSession, saveSession, clearSession };
