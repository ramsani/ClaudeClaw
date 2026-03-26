'use strict';

const crypto = require('crypto');

const BRIDGE_TOKEN    = process.env.BRIDGE_TOKEN    || '';
const BRIDGE_PASSWORD = process.env.BRIDGE_PASSWORD || '';

// Sessions activas: token → { createdAt }
const sessions = new Map();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';')
      .map(s => s.trim().split('='))
      .filter(p => p.length === 2)
      .map(([k, v]) => [k.trim(), decodeURIComponent(v.trim())])
  );
}

// Comparación en tiempo constante para evitar timing attacks
function safeCompare(a, b) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch { return false; }
}

// Verificar autenticación en requests HTTP
// Acepta: header X-Bridge-Token, query ?token=, o cookie bridge_session
function verifyToken(req) {
  // Opción 1: token interno para servicios (n8n, Telegram webhook)
  const headerToken = req.headers['x-bridge-token'];
  if (headerToken && BRIDGE_TOKEN && safeCompare(headerToken, BRIDGE_TOKEN)) return true;

  // Opción 2: token en query string (para WS desde PWA pre-login)
  const url = new URL(req.url, 'http://x');
  const queryToken = url.searchParams.get('token');
  if (queryToken && BRIDGE_TOKEN && safeCompare(queryToken, BRIDGE_TOKEN)) return true;

  // Opción 3: cookie de sesión (después de login con BRIDGE_PASSWORD)
  const cookies = parseCookies(req);
  const sessionToken = cookies['bridge_session'];
  if (sessionToken && sessions.has(sessionToken)) {
    const sess = sessions.get(sessionToken);
    if (Date.now() - sess.createdAt < SESSION_TTL_MS) return true;
    sessions.delete(sessionToken);
  }

  // Sin BRIDGE_TOKEN configurado: acceso abierto (modo desarrollo)
  if (!BRIDGE_TOKEN && !BRIDGE_PASSWORD) return true;

  return false;
}

// Handler POST /api/login { password }
function loginHandler(req, res, body) {
  try {
    const { password } = JSON.parse(body.toString());
    if (!BRIDGE_PASSWORD || password !== BRIDGE_PASSWORD) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_password' }));
      return;
    }
    const token = generateSessionToken();
    sessions.set(token, { createdAt: Date.now() });

    const cookie = [
      `bridge_session=${token}`,
      'HttpOnly',
      'Path=/',
      `Max-Age=${30 * 24 * 3600}`,
      'SameSite=Strict',
      // Solo agregar Secure si el request viene por HTTPS (Cloudflare pone x-forwarded-proto)
      req.headers['x-forwarded-proto'] === 'https' ? 'Secure' : '',
    ].filter(Boolean).join('; ');

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    });
    res.end(JSON.stringify({ ok: true }));
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
}, 60 * 60 * 1000); // cada hora

module.exports = { verifyToken, loginHandler, parseCookies };
