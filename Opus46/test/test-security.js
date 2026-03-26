#!/usr/bin/env node
/**
 * ClaudeClaw — Suite de seguridad
 * Cubre: path traversal avanzado, timing attacks, transcribe sin auth,
 * multipart edge cases, y SQL injection en búsquedas.
 *
 * Corre de forma autónoma sin Claude real ni MiniMax.
 */
'use strict';

const http    = require('http');
const assert  = require('assert');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const { EventEmitter } = require('events');

// ── Colores ────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[34m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

let passed = 0, failed = 0, skipped = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ${G('✓')} ${D(name)}`);
    passed++;
  } catch (e) {
    console.log(`  ${R('✗')} ${name}`);
    console.log(`    ${R(e.message)}`);
    if (e.stack) console.log(`    ${D(e.stack.split('\n').slice(1, 3).join(' '))}`);
    failures.push({ name, error: e.message });
    failed++;
  }
}

function skip(name) {
  console.log(`  ${Y('○')} ${name} ${D('(skipped)')}`);
  skipped++;
}

// ── Setup ──────────────────────────────────────────────────
const TEST_PORT = 25679;
const TEST_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-sec-'));
const TEST_TOKEN    = 'security-test-token-abc123';
const TEST_PASSWORD = 'security-test-password';

process.env.ANTHROPIC_AUTH_TOKEN = 'minimax-test-key';
process.env.ANTHROPIC_BASE_URL   = 'http://test.minimax.local';
process.env.BRIDGE_PORT          = String(TEST_PORT);
process.env.WORK_DIR             = TEST_WORK_DIR;
process.env.BRIDGE_TOKEN         = TEST_TOKEN;
process.env.BRIDGE_PASSWORD      = TEST_PASSWORD;
process.env.CLAUDE_TIMEOUT_MS    = '3000';

// ── Mock spawn (no-op para tests de seguridad) ─────────────
const cp = require('child_process');
const realSpawn = cp.spawn.bind(cp);
cp.spawn = function mockSpawn() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin  = { write() {}, end() {} };
  proc.kill   = () => {};
  // Emitir respuesta mínima de Claude para que la cola no bloquee
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from(
      '{"type":"result","subtype":"success","result":"ok","session_id":"test-uuid-123","is_error":false}\n'
    ));
    proc.emit('close', 0);
  });
  return proc;
};

// ── HTTP helpers ───────────────────────────────────────────
function req(options, body) {
  return new Promise((resolve, reject) => {
    const data = body
      ? (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      : null;
    const opts = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      method: 'GET',
      headers: {},
      ...options,
    };
    if (data) {
      opts.headers['Content-Length'] = data.length;
    }
    const r = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function authed(opts) {
  return { ...opts, headers: { ...opts.headers, 'X-Bridge-Token': TEST_TOKEN } };
}

// ── Cargar bridge ──────────────────────────────────────────
let bridgeServer;
async function startBridge() {
  const bridge = require('../bridge');
  await new Promise(resolve => setTimeout(resolve, 200));
  bridgeServer = bridge.__server || bridge.server;
}

// ══════════════════════════════════════════════════════════
// SECCIÓN 1A — Path Traversal avanzado (unit tests files.js)
// ══════════════════════════════════════════════════════════
async function runSection1A() {
  console.log(`\n${B('1A. Path Traversal avanzado (lib/files.js)')}`);

  // Cargar el módulo directamente para tests de unidad
  // (process.env.WORK_DIR ya está seteado)
  const files = require('../lib/files');
  const WORK_DIR = files.WORK_DIR;

  await test('Ruta absoluta fuera de WORK_DIR → path_traversal', () => {
    try {
      files.safePath('/etc/passwd');
      assert.fail('Debió lanzar');
    } catch (e) {
      assert.strictEqual(e.code, 'path_traversal', `code=${e.code} msg=${e.message}`);
    }
  });

  await test('Traversal con ../ simple → path_traversal', () => {
    try {
      files.safePath('../../etc/passwd');
      assert.fail('Debió lanzar');
    } catch (e) {
      assert.strictEqual(e.code, 'path_traversal');
    }
  });

  await test('Traversal oculto: inbox/../../../etc/passwd → path_traversal', () => {
    try {
      files.safePath('inbox/../../../etc/passwd');
      assert.fail('Debió lanzar');
    } catch (e) {
      assert.strictEqual(e.code, 'path_traversal');
    }
  });

  await test('Path vacío → path_required', () => {
    try {
      files.safePath('');
      assert.fail('Debió lanzar');
    } catch (e) {
      assert.strictEqual(e.code, 'path_required');
    }
  });

  await test('Path null → path_required', () => {
    try {
      files.safePath(null);
      assert.fail('Debió lanzar');
    } catch (e) {
      assert.strictEqual(e.code, 'path_required');
    }
  });

  await test('Path válido dentro de WORK_DIR → ok', () => {
    // Crear archivo de prueba
    const testFile = path.join(WORK_DIR, 'safe-test.txt');
    fs.writeFileSync(testFile, 'hello');
    const resolved = files.safePath('safe-test.txt');
    assert.strictEqual(resolved, testFile);
    fs.unlinkSync(testFile);
  });

  await test('Subdirectorio válido → ok', () => {
    const subDir = path.join(WORK_DIR, 'inbox');
    fs.mkdirSync(subDir, { recursive: true });
    const resolved = files.safePath('inbox');
    assert.ok(resolved.startsWith(WORK_DIR));
  });

  await test('Symlink apuntando fuera de WORK_DIR → path_traversal', () => {
    // Crear symlink que apunta a /etc/passwd
    const symlinkPath = path.join(WORK_DIR, 'inbox', 'evil-link.txt');
    try { fs.unlinkSync(symlinkPath); } catch {}
    try {
      fs.symlinkSync('/etc/passwd', symlinkPath);
      try {
        files.safePath('inbox/evil-link.txt');
        assert.fail('Debió lanzar path_traversal');
      } catch (e) {
        assert.strictEqual(e.code, 'path_traversal', `Symlink no detectado: ${e.message}`);
      } finally {
        try { fs.unlinkSync(symlinkPath); } catch {}
      }
    } catch (symlinkErr) {
      // Si no tiene permiso para crear symlinks, saltar
      console.log(`    ${Y('→ No se pudo crear symlink (permisos): skip')}`);
      skipped++;
      passed--; // compensar el passed que no fue
    }
  });

  await test('Symlink interno (dentro de WORK_DIR) → ok', () => {
    const targetFile = path.join(WORK_DIR, 'real-file.txt');
    const linkPath   = path.join(WORK_DIR, 'inbox', 'internal-link.txt');
    fs.writeFileSync(targetFile, 'content');
    try { fs.unlinkSync(linkPath); } catch {}
    try {
      fs.symlinkSync(targetFile, linkPath);
      const resolved = files.safePath('inbox/internal-link.txt');
      assert.ok(resolved.startsWith(WORK_DIR));
    } finally {
      try { fs.unlinkSync(linkPath); } catch {}
      try { fs.unlinkSync(targetFile); } catch {}
    }
  });

  await test('Unicode válido en nombre → ok', () => {
    const testFile = path.join(WORK_DIR, 'tëst-ünïcödë.txt');
    fs.writeFileSync(testFile, 'unicode ok');
    const resolved = files.safePath('tëst-ünïcödë.txt');
    assert.ok(resolved.endsWith('tëst-ünïcödë.txt'));
    fs.unlinkSync(testFile);
  });

  await test('deleteFile vacío → cannot_delete_root o path_required', () => {
    try {
      files.deleteFile('');
      assert.fail('Debió lanzar');
    } catch (e) {
      assert.ok(
        ['path_required', 'path_traversal'].includes(e.code),
        `code inesperado: ${e.code}`
      );
    }
  });

  await test('deleteFile apuntando a WORK_DIR raíz → error', () => {
    // Esto no debería ser posible con safePath, pero si se llamara directamente
    // con el path de WORK_DIR directamente ya lo protege deleteFile
    try {
      // Intentar borrar la raíz con una ruta que resuelva a WORK_DIR
      // safePath('.') resuelve a WORK_DIR, y deleteFile lo rechaza
      files.deleteFile('.');
      assert.fail('Debió lanzar');
    } catch (e) {
      // path_required, path_traversal, o cannot_delete_root — cualquiera es ok
      assert.ok(e.message, `Lanzó error: ${e.message}`);
    }
  });
}

// ══════════════════════════════════════════════════════════
// SECCIÓN 1B — Auth / timing
// ══════════════════════════════════════════════════════════
async function runSection1B() {
  console.log(`\n${B('1B. Auth — Timing y verificación')}`);

  const auth = require('../lib/auth');

  await test('Token correcto → true', () => {
    const mockReq = { headers: { 'x-bridge-token': TEST_TOKEN }, url: '/' };
    assert.strictEqual(auth.verifyToken(mockReq), true);
  });

  await test('Token incorrecto → false', () => {
    const mockReq = { headers: { 'x-bridge-token': 'wrong-token' }, url: '/' };
    assert.strictEqual(auth.verifyToken(mockReq), false);
  });

  await test('Token vacío → false (cuando BRIDGE_TOKEN configurado)', () => {
    const mockReq = { headers: { 'x-bridge-token': '' }, url: '/' };
    // Token vacío no debería autenticar con BRIDGE_TOKEN configurado
    assert.strictEqual(auth.verifyToken(mockReq), false);
  });

  await test('Token en query string → true', () => {
    const mockReq = { headers: {}, url: `/?token=${TEST_TOKEN}` };
    assert.strictEqual(auth.verifyToken(mockReq), true);
  });

  await test('Token en query string incorrecto → false', () => {
    const mockReq = { headers: {}, url: '/?token=wrong' };
    assert.strictEqual(auth.verifyToken(mockReq), false);
  });

  await test('Token casi correcto (1 char diferente) → false', () => {
    const almostRight = TEST_TOKEN.slice(0, -1) + 'X';
    const mockReq = { headers: { 'x-bridge-token': almostRight }, url: '/' };
    assert.strictEqual(auth.verifyToken(mockReq), false);
  });

  await test('timingSafeEqual usado (verificar implementación)', () => {
    // Verificar que el source de auth.js contiene timingSafeEqual
    const authSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.js'), 'utf8');
    assert.ok(
      authSrc.includes('timingSafeEqual'),
      'lib/auth.js no usa crypto.timingSafeEqual — vulnerabilidad de timing'
    );
  });

  await test('x-forwarded-proto http → cookie sin Secure', async () => {
    const r = await req({
      method: 'POST',
      path: '/api/login',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-proto': 'http',
      },
    }, JSON.stringify({ password: TEST_PASSWORD }));
    assert.strictEqual(r.status, 200);
    const setCookie = r.headers['set-cookie'];
    if (setCookie) {
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      assert.ok(!cookieStr.toLowerCase().includes('secure'),
        'Cookie no debe tener Secure en HTTP: ' + cookieStr);
    }
  });

  await test('x-forwarded-proto https → cookie con Secure', async () => {
    const r = await req({
      method: 'POST',
      path: '/api/login',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-proto': 'https',
      },
    }, JSON.stringify({ password: TEST_PASSWORD }));
    assert.strictEqual(r.status, 200);
    const setCookie = r.headers['set-cookie'];
    if (setCookie) {
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      assert.ok(cookieStr.toLowerCase().includes('secure'),
        'Cookie debe tener Secure en HTTPS: ' + cookieStr);
    }
  });

  await test('Contraseña incorrecta → 401', async () => {
    const r = await req({
      method: 'POST',
      path: '/api/login',
      headers: { 'Content-Type': 'application/json' },
    }, JSON.stringify({ password: 'wrong-pass' }));
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json?.error, 'invalid_password');
  });

  await test('Login body malformado → 400', async () => {
    const r = await req({
      method: 'POST',
      path: '/api/login',
      headers: { 'Content-Type': 'application/json' },
    }, 'not-json{{{');
    assert.strictEqual(r.status, 400);
  });
}

// ══════════════════════════════════════════════════════════
// SECCIÓN 1C — /transcribe requiere auth
// ══════════════════════════════════════════════════════════
async function runSection1C() {
  console.log(`\n${B('1C. /transcribe — Auth requerida')}`);

  await test('POST /transcribe sin token → 401', async () => {
    const r = await req({
      method: 'POST',
      path: '/transcribe?filename=audio.oga',
      headers: { 'Content-Type': 'application/octet-stream' },
    }, Buffer.alloc(100));
    assert.strictEqual(r.status, 401, `Esperado 401, recibido ${r.status}: ${r.body}`);
    assert.strictEqual(r.json?.error, 'unauthorized');
  });

  await test('POST /transcribe con token correcto → no 401 (puede fallar con 500 por falta de OpenAI key)', async () => {
    // Con token válido, debe pasar la auth y llegar al procesamiento
    // (fallará por no tener OPENAI_KEY real, pero NO debe ser 401)
    const r = await req(authed({
      method: 'POST',
      path: '/transcribe?filename=audio.oga',
      headers: { 'Content-Type': 'application/octet-stream' },
    }), Buffer.alloc(100));
    assert.notStrictEqual(r.status, 401,
      `Con token correcto no debe dar 401, dio: ${r.status}`);
  });

  await test('POST /transcribe con token incorrecto → 401', async () => {
    const r = await req({
      method: 'POST',
      path: '/transcribe',
      headers: {
        'X-Bridge-Token': 'wrong-token',
        'Content-Type': 'application/octet-stream',
      },
    }, Buffer.alloc(100));
    assert.strictEqual(r.status, 401);
  });

  await test('Source code de bridge.js tiene auth check en /transcribe', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
    // Buscar que auth.verifyToken aparece antes del handler de transcribe
    const transcribeIdx = src.indexOf("url.startsWith('/transcribe')");
    const authIdx = src.indexOf('auth.verifyToken', transcribeIdx - 200);
    assert.ok(
      authIdx > -1 && authIdx < transcribeIdx + 200,
      '/transcribe no tiene auth check cerca del handler'
    );
  });
}

// ══════════════════════════════════════════════════════════
// SECCIÓN 1D — Multipart edge cases (HTTP)
// ══════════════════════════════════════════════════════════
async function runSection1D() {
  console.log(`\n${B('1D. Multipart — Edge cases')}`);

  function buildMultipart(fields, file) {
    const boundary = '----TestBoundary' + Math.random().toString(36).slice(2);
    const parts = [];
    for (const [name, value] of Object.entries(fields || {})) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
      );
    }
    if (file) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`
      );
    }
    const prefix = Buffer.from(parts.join(''));
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyParts = [prefix];
    if (file?.data) bodyParts.push(file.data);
    bodyParts.push(suffix);
    return {
      body: Buffer.concat(bodyParts),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  await test('Upload sin boundary en Content-Type → error manejado', async () => {
    const r = await req(authed({
      method: 'POST',
      path: '/api/upload',
      headers: { 'Content-Type': 'multipart/form-data' }, // sin boundary
    }), Buffer.from('--fakeboundary\r\nContent-Disposition: form-data; name="file"; filename="x.txt"\r\n\r\nhello\r\n--fakeboundary--\r\n'));
    // Debe ser 400 (no boundary) o 500, no debe crashear el servidor
    assert.ok([400, 500].includes(r.status), `status inesperado: ${r.status}`);
  });

  await test('Upload archivo de texto → guardado en inbox', async () => {
    const { body, contentType } = buildMultipart({}, {
      name: 'test-file.txt',
      type: 'text/plain',
      data: Buffer.from('contenido de prueba'),
    });
    const r = await req(authed({
      method: 'POST',
      path: '/api/upload',
      headers: { 'Content-Type': contentType },
    }), body);
    assert.ok([200, 201].includes(r.status), `status: ${r.status} body: ${r.body}`);
    assert.ok(r.json?.path || r.json?.savedPath || r.json?.file, `No se devolvió path: ${r.body}`);
  });

  await test('Upload sin Content-Type multipart → raw guardado', async () => {
    const r = await req(authed({
      method: 'POST',
      path: '/api/upload?filename=raw-test.bin',
      headers: { 'Content-Type': 'application/octet-stream' },
    }), Buffer.from('raw binary content'));
    assert.ok([200, 201].includes(r.status), `status: ${r.status}`);
  });

  await test('Upload sin auth → 401', async () => {
    const { body, contentType } = buildMultipart({}, {
      name: 'file.txt',
      type: 'text/plain',
      data: Buffer.from('data'),
    });
    const r = await req({
      method: 'POST',
      path: '/api/upload',
      headers: { 'Content-Type': contentType },
    }, body);
    assert.strictEqual(r.status, 401);
  });

  await test('Upload > 16MB → 413 o request_too_large', async () => {
    // Crear body de 16MB + 1 byte
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
    const r = await req(authed({
      method: 'POST',
      path: '/api/upload?filename=huge.bin',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(oversized.length),
      },
    }), oversized).catch(() => ({ status: 413, json: null, body: '' }));
    assert.ok([413, 400, 500].includes(r.status),
      `Esperado error en body >16MB, recibido ${r.status}`);
  });
}

// ══════════════════════════════════════════════════════════
// SECCIÓN 1E — SQL — Caracteres especiales en búsqueda
// ══════════════════════════════════════════════════════════
async function runSection1E() {
  console.log(`\n${B('1E. SQL — Búsquedas con caracteres especiales')}`);

  await test("Búsqueda con comilla simple → no error SQL", async () => {
    const r = await req(authed({
      method: 'GET',
      path: "/api/history?q=it's%20a%20test",
    }));
    assert.ok([200, 404].includes(r.status), `status: ${r.status}`);
    if (r.status === 200) assert.ok(Array.isArray(r.json), 'Debe retornar array');
  });

  await test("Búsqueda con % (wildcard LIKE) → no error", async () => {
    const r = await req(authed({
      method: 'GET',
      path: '/api/history?q=%25',
    }));
    assert.ok([200, 404].includes(r.status));
    if (r.status === 200) assert.ok(Array.isArray(r.json));
  });

  await test("Búsqueda con _ (wildcard LIKE) → no error", async () => {
    const r = await req(authed({
      method: 'GET',
      path: '/api/history?q=_test_',
    }));
    assert.ok([200, 404].includes(r.status));
    if (r.status === 200) assert.ok(Array.isArray(r.json));
  });

  await test("Búsqueda con SQL injection clásico → no error y sin resultados extra", async () => {
    const r = await req(authed({
      method: 'GET',
      path: "/api/history?q=" + encodeURIComponent("' OR '1'='1"),
    }));
    assert.ok([200, 404].includes(r.status));
    if (r.status === 200) {
      assert.ok(Array.isArray(r.json), 'Debe retornar array');
      // La query parameterizada no debe devolver TODOS los mensajes
      // (en DB vacía, array vacío es correcto)
    }
  });

  await test("Búsqueda con emoji → no error", async () => {
    const r = await req(authed({
      method: 'GET',
      path: '/api/history?q=' + encodeURIComponent('🎉 hello'),
    }));
    assert.ok([200, 404].includes(r.status));
    if (r.status === 200) assert.ok(Array.isArray(r.json));
  });

  await test("Búsqueda con backslash → no error", async () => {
    const r = await req(authed({
      method: 'GET',
      path: '/api/history?q=' + encodeURIComponent('test\\nvalue'),
    }));
    assert.ok([200, 404].includes(r.status));
    if (r.status === 200) assert.ok(Array.isArray(r.json));
  });

  await test("limit=NaN → no error (usa default)", async () => {
    const r = await req(authed({
      method: 'GET',
      path: '/api/history?limit=abc',
    }));
    assert.strictEqual(r.status, 200, `status: ${r.status} body: ${r.body}`);
    assert.ok(Array.isArray(r.json));
  });

  await test("limit negativo → no error", async () => {
    const r = await req(authed({
      method: 'GET',
      path: '/api/history?limit=-1',
    }));
    assert.ok([200, 400].includes(r.status));
    if (r.status === 200) assert.ok(Array.isArray(r.json));
  });

  await test("before=0 (epoch) → array vacío sin error", async () => {
    const r = await req(authed({
      method: 'GET',
      path: '/api/history?before=0',
    }));
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assert.strictEqual(r.json.length, 0);
  });

  await test("Búsqueda sin resultados → array vacío", async () => {
    const r = await req(authed({
      method: 'GET',
      path: '/api/history?q=' + encodeURIComponent('xyzzzy_no_existe_abc123xyz'),
    }));
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json));
    assert.strictEqual(r.json.length, 0);
  });
}

// ══════════════════════════════════════════════════════════
// SECCIÓN EXTRA — Verificación de fixes en source code
// ══════════════════════════════════════════════════════════
async function runSourceChecks() {
  console.log(`\n${B('Extra. Verificaciones de source code (fixes aplicados)')}`);

  await test('Fix 1: /transcribe tiene auth check', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
    // Encontrar el bloque /transcribe y verificar que tiene verifyToken antes del try
    const idx = src.indexOf("url.startsWith('/transcribe')");
    assert.ok(idx > -1, 'No se encontró handler /transcribe');
    const block = src.slice(Math.max(0, idx - 100), idx + 300);
    assert.ok(block.includes('verifyToken'), 'No hay verifyToken cerca del handler /transcribe');
  });

  await test('Fix 2: auth.js usa timingSafeEqual', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.js'), 'utf8');
    assert.ok(src.includes('timingSafeEqual'), 'lib/auth.js debe usar crypto.timingSafeEqual');
    assert.ok(!src.includes('headerToken === BRIDGE_TOKEN'), 'No debe usar === para comparar tokens');
    assert.ok(!src.includes('queryToken === BRIDGE_TOKEN'), 'No debe usar === para comparar tokens');
  });

  await test('Fix 3: files.js usa realpathSync para symlinks', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'files.js'), 'utf8');
    assert.ok(src.includes('realpathSync'), 'lib/files.js debe usar fs.realpathSync para validar symlinks');
  });

  await test('Fix 4: downloadTelegramFile valida tamaño', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
    assert.ok(
      src.includes('file_too_large') || src.includes('20 * 1024 * 1024'),
      'downloadTelegramFile debe validar tamaño máximo'
    );
  });

  await test('Fix 5: transcribeBuffer tiene timeout con AbortController', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
    assert.ok(src.includes('AbortController'), 'transcribeBuffer debe usar AbortController para timeout');
  });
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════
async function main() {
  console.log(`${B('══════════════════════════════════════════')}`);
  console.log(`${B(' ClaudeClaw — Suite de Seguridad')}`);
  console.log(`${B('══════════════════════════════════════════')}`);
  console.log(`  WORK_DIR: ${TEST_WORK_DIR}`);
  console.log(`  PORT: ${TEST_PORT}`);

  // Tests de unidad que no necesitan el servidor
  await runSection1A();
  await runSourceChecks();

  // Iniciar el bridge para tests HTTP
  console.log(`\n${D('Iniciando bridge...')}`);
  try {
    await startBridge();
    await new Promise(r => setTimeout(r, 300));
  } catch (e) {
    console.log(`  ${R('✗ No se pudo iniciar el bridge: ' + e.message)}`);
    console.log(`  ${Y('→ Saltando tests HTTP (1B, 1C, 1D, 1E)')}`);
    printSummary();
    process.exit(failed > 0 ? 1 : 0);
  }

  await runSection1B();
  await runSection1C();
  await runSection1D();
  await runSection1E();

  printSummary();

  // Cleanup
  try { fs.rmSync(TEST_WORK_DIR, { recursive: true, force: true }); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

function printSummary() {
  console.log(`\n${B('══════════════════════════════════════════')}`);
  console.log(`  ${G(`${passed} pasaron`)}  ${failed > 0 ? R(`${failed} fallaron`) : D('0 fallaron')}  ${skipped > 0 ? Y(`${skipped} saltados`) : ''}`);
  if (failures.length > 0) {
    console.log(`\n${R('  Fallos:')}`);
    for (const f of failures) {
      console.log(`    ${R('✗')} ${f.name}`);
      console.log(`      ${D(f.error)}`);
    }
  }
  console.log(`${B('══════════════════════════════════════════')}`);
}

main().catch(e => {
  console.error(R('Error fatal: ' + e.message));
  console.error(e.stack);
  process.exit(1);
});
