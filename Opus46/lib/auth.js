'use strict';

const crypto = require('crypto');
const pgdb   = require('./pgdb');

const BRIDGE_TOKEN    = process.env.BRIDGE_TOKEN    || '';
const BRIDGE_PASSWORD = process.env.BRIDGE_PASSWORD || '';

// Sessions activas: token → { userId, createdAt }
const sessions = new Map();
const SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000; // 10 años

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Comparación en tiempo constante para evitar timing attacks
function safeCompare(a, b) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';')
      .map(s => s.trim().split('='))
      .filter(p => p.length >= 2)
      .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())])
  );
}

// Obtener userId de la sesión activa (para rutas que necesitan saber quién es)
function getSessionUser(req) {
  const cookies = parseCookies(req);
  const sessionToken = cookies['bridge_session'];
  if (sessionToken && sessions.has(sessionToken)) {
    const sess = sessions.get(sessionToken);
    if (Date.now() - sess.createdAt < SESSION_TTL_MS) return sess.userId || '';
    sessions.delete(sessionToken);
  }
  return '';
}

// Verificar autenticación en requests HTTP
function verifyToken(req) {
  // Opción 1: BRIDGE_TOKEN interno (n8n, Telegram webhook)
  const headerToken = req.headers['x-bridge-token'];
  if (headerToken && BRIDGE_TOKEN && safeCompare(headerToken, BRIDGE_TOKEN)) return true;

  // Opción 2: token en query string
  const url = new URL(req.url, 'http://x');
  const queryToken = url.searchParams.get('token');
  if (queryToken && BRIDGE_TOKEN && safeCompare(queryToken, BRIDGE_TOKEN)) return true;

  // Opción 3: cookie de sesión (login con user/password)
  const cookies = parseCookies(req);
  const sessionToken = cookies['bridge_session'];
  if (sessionToken && sessions.has(sessionToken)) {
    const sess = sessions.get(sessionToken);
    if (Date.now() - sess.createdAt < SESSION_TTL_MS) return true;
    sessions.delete(sessionToken);
  }

  // Sin BRIDGE_TOKEN configurado: modo desarrollo abierto
  if (!BRIDGE_TOKEN && !BRIDGE_PASSWORD) return true;

  return false;
}

// Handler POST /api/login { username, password }
async function loginHandler(req, res, body) {
  try {
    const { username, password } = JSON.parse(body.toString());

    let userId = '';

    // Modo multi-usuario: verificar en PostgreSQL
    if (username && password) {
      try {
        const user = await pgdb.verifyUserPassword(username, password);
        if (user) {
          userId = user.user_id;
        } else {
          // Fallback: admin login con BRIDGE_PASSWORD
          if (username === 'admin' && BRIDGE_PASSWORD && password === BRIDGE_PASSWORD) {
            userId = 'admin';
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_credentials' }));
            return;
          }
        }
      } catch (pgErr) {
        // Si PostgreSQL no disponible, fallback a BRIDGE_PASSWORD
        console.warn('[auth] PostgreSQL no disponible, usando fallback:', pgErr.message);
        if (!BRIDGE_PASSWORD || password !== BRIDGE_PASSWORD) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_credentials' }));
          return;
        }
      }
    } else if (password && !username) {
      // Modo legacy: solo contraseña
      if (!BRIDGE_PASSWORD || password !== BRIDGE_PASSWORD) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_password' }));
        return;
      }
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'username and password required' }));
      return;
    }

    const token = generateSessionToken();
    sessions.set(token, { userId, createdAt: Date.now() });

    const isHttps = req.headers['x-forwarded-proto'] === 'https';
    const cookie = [
      `bridge_session=${token}`,
      'HttpOnly',
      'Path=/',
      `Max-Age=${10 * 365 * 24 * 3600}`,
      'SameSite=Strict',
      isHttps ? 'Secure' : '',
    ].filter(Boolean).join('; ');

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    });
    res.end(JSON.stringify({ ok: true, userId }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_request' }));
  }
}

// Limpiar sesiones expiradas periódicamente
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt >= SESSION_TTL_MS) sessions.delete(k);
  }
}, 60 * 60 * 1000);

module.exports = { verifyToken, loginHandler, parseCookies, getSessionUser };
