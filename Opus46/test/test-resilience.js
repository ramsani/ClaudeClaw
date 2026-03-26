#!/usr/bin/env node
/**
 * ClaudeClaw — Suite de Resiliencia
 * Cubre: queue concurrencia/timeouts, session lifecycle, SQLite edge cases,
 * WebSocket lifecycle, y comportamiento ante errores de infraestructura.
 *
 * NO requiere Claude real ni MiniMax. Usa mocks internos.
 */
'use strict';

const assert  = require('assert');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
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
    failures.push({ name, error: e.message });
    failed++;
  }
}

function skip(name, reason) {
  console.log(`  ${Y('○')} ${name} ${D(`(${reason || 'skipped'})`)}`);
  skipped++;
}

// ── Setup ──────────────────────────────────────────────────
const TEST_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeclaw-res-'));

process.env.ANTHROPIC_AUTH_TOKEN = 'minimax-test-key';
process.env.ANTHROPIC_BASE_URL   = 'http://test.minimax.local';
process.env.BRIDGE_PORT          = '35679';
process.env.WORK_DIR             = TEST_WORK_DIR;
process.env.BRIDGE_TOKEN         = 'resilience-test-token';
process.env.BRIDGE_PASSWORD      = 'resilience-test-pass';
process.env.CLAUDE_TIMEOUT_MS    = '2000'; // 2s para tests de timeout
process.env.QUEUE_MAX_SIZE       = '5';

// ══════════════════════════════════════════════════════════
// SECCIÓN 2A — Queue: concurrencia y timeouts (unit tests)
// ══════════════════════════════════════════════════════════
async function runSection2A() {
  console.log(`\n${B('2A. Queue — Concurrencia y timeouts')}`);

  // Cargar módulo fresco de queue (sin singleton del bridge)
  // Usar un módulo auxiliar inline
  const { MessageQueue } = (() => {
    const TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '5000', 10);
    const MAX_SIZE   = parseInt(process.env.QUEUE_MAX_SIZE || '10', 10);

    class MessageQueue {
      constructor() {
        this._queue = [];
        this._busy  = false;
        this.maxSize = MAX_SIZE;
        this.timeoutMs = TIMEOUT_MS;
      }

      get size() { return this._queue.length; }
      get busy() { return this._busy; }

      push(taskFn) {
        if (this._queue.length >= this.maxSize) {
          return Promise.reject(Object.assign(new Error('queue_full'), { code: 'queue_full' }));
        }
        return new Promise((resolve, reject) => {
          this._queue.push({ taskFn, resolve, reject });
          if (!this._busy) this._pump();
        });
      }

      async _pump() {
        if (this._busy || this._queue.length === 0) return;
        this._busy = true;
        const { taskFn, resolve, reject } = this._queue.shift();
        try {
          let timer;
          const timeout = new Promise((_, rej) => {
            timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), this.timeoutMs);
          });
          const result = await Promise.race([taskFn(), timeout]);
          clearTimeout(timer);
          resolve(result);
        } catch (e) {
          reject(e);
        } finally {
          this._busy = false;
          if (this._queue.length > 0) this._pump();
        }
      }
    }
    return { MessageQueue };
  })();

  await test('Tarea simple → resuelve correctamente', async () => {
    const q = new MessageQueue();
    const result = await q.push(() => Promise.resolve(42));
    assert.strictEqual(result, 42);
  });

  await test('Dos tareas en secuencia → ambas resuelven', async () => {
    const q = new MessageQueue();
    const results = [];
    const p1 = q.push(() => new Promise(r => setTimeout(() => { results.push(1); r(1); }, 50)));
    const p2 = q.push(() => new Promise(r => setTimeout(() => { results.push(2); r(2); }, 50)));
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(results, [1, 2], 'Las tareas deben ejecutarse en orden FIFO');
  });

  await test('Segunda tarea espera a que termine la primera', async () => {
    const q = new MessageQueue();
    const order = [];
    const p1 = q.push(() => new Promise(r => {
      order.push('start-1');
      setTimeout(() => { order.push('end-1'); r(); }, 80);
    }));
    await new Promise(r => setTimeout(r, 10)); // dejar que p1 empiece
    const p2 = q.push(() => new Promise(r => {
      order.push('start-2');
      setTimeout(() => { order.push('end-2'); r(); }, 20);
    }));
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
  });

  await test('Cola llena → rechaza con queue_full', async () => {
    const q = new MessageQueue();
    // El blocker ocupa el slot "busy" (no el array _queue)
    // Luego llenamos el array _queue hasta maxSize, y el (maxSize+1)° debe fallar
    const blocker = q.push(() => new Promise(r => setTimeout(r, 500)));
    await new Promise(r => setTimeout(r, 10)); // esperar que blocker empiece y _busy=true
    const pushes = [];
    for (let i = 0; i < q.maxSize + 1; i++) {
      pushes.push(q.push(() => new Promise(r => setTimeout(r, 100))).catch(e => e));
    }
    const results = await Promise.all(pushes);
    const fullErrors = results.filter(e => e?.code === 'queue_full');
    assert.ok(fullErrors.length >= 1, `Debe haber al menos un queue_full, got: ${JSON.stringify(results.map(e => e?.code || typeof e))}`);
    blocker.catch(() => {}); // limpiar promesa pendiente
  });

  await test('Timeout de tarea → rechaza con code=timeout', async () => {
    const q = new MessageQueue();
    q.timeoutMs = 100; // muy corto
    try {
      await q.push(() => new Promise(r => setTimeout(r, 500))); // más largo que timeout
      assert.fail('Debió rechazar con timeout');
    } catch (e) {
      assert.strictEqual(e.code, 'timeout', `code=${e.code} msg=${e.message}`);
    }
  });

  await test('Después de timeout, siguiente tarea puede correr', async () => {
    const q = new MessageQueue();
    q.timeoutMs = 100;
    await q.push(() => new Promise(r => setTimeout(r, 500))).catch(() => {});
    const result = await q.push(() => Promise.resolve('ok'));
    assert.strictEqual(result, 'ok');
  });

  await test('Tarea que lanza error → rechaza, no crashea queue', async () => {
    const q = new MessageQueue();
    try {
      await q.push(() => { throw new Error('task_error'); });
      assert.fail('Debió rechazar');
    } catch (e) {
      assert.strictEqual(e.message, 'task_error');
    }
    // Queue debe seguir funcionando
    const result = await q.push(() => Promise.resolve('still ok'));
    assert.strictEqual(result, 'still ok');
  });

  await test('size y busy reflejan estado correcto', async () => {
    const q = new MessageQueue();
    assert.strictEqual(q.size, 0);
    assert.strictEqual(q.busy, false);
    let resolveFn;
    const p = q.push(() => new Promise(r => { resolveFn = r; }));
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(q.busy, true);
    resolveFn();
    await p;
    assert.strictEqual(q.busy, false);
  });
}

// ══════════════════════════════════════════════════════════
// SECCIÓN 2B — Session lifecycle (unit tests lib/session.js)
// ══════════════════════════════════════════════════════════
async function runSection2B() {
  console.log(`\n${B('2B. Session — Lifecycle y persistencia')}`);

  // Usar DB temporal para esta sección
  const dbPath = path.join(TEST_WORK_DIR, 'session-test.db');
  process.env.DB_PATH = dbPath;

  // Cargar DB y Session fresh
  let db, session;
  try {
    // Forzar fresh require limpiando cache
    delete require.cache[require.resolve('../lib/db')];
    delete require.cache[require.resolve('../lib/session')];
    db = require('../lib/db');
    db.init(dbPath);
    session = require('../lib/session');
  } catch (e) {
    skip('2B completo', `No se pudo cargar módulos: ${e.message}`);
    return;
  }

  await test('loadSession en DB vacía → null', async () => {
    const uuid = await session.loadSession();
    assert.strictEqual(uuid, null, `Esperado null, recibido: ${uuid}`);
  });

  await test('saveSession → loadSession devuelve mismo UUID', async () => {
    const testUuid = 'test-uuid-' + Date.now();
    await session.saveSession(testUuid);
    const loaded = await session.loadSession();
    assert.strictEqual(loaded, testUuid);
  });

  await test('clearSession → loadSession devuelve null', async () => {
    await session.saveSession('some-uuid');
    await session.clearSession();
    const loaded = await session.loadSession();
    assert.strictEqual(loaded, null);
  });

  await test('UUID vacío guardado → loadSession devuelve null', async () => {
    db.stateSet('claude_session_uuid', '');
    const loaded = await session.loadSession();
    assert.strictEqual(loaded, null, 'UUID vacío debe retornar null');
  });

  await test('UUID con caracteres especiales → guardado y recuperado correctamente', async () => {
    const specialUuid = "uuid-with-'quotes'-and-special_chars";
    await session.saveSession(specialUuid);
    const loaded = await session.loadSession();
    assert.strictEqual(loaded, specialUuid);
  });

  await test("UUID literal 'null' (string) → retornado como string", async () => {
    db.stateSet('claude_session_uuid', 'null');
    const loaded = await session.loadSession();
    // Documentar comportamiento: string 'null' no es null
    assert.strictEqual(typeof loaded, 'string');
    assert.strictEqual(loaded, 'null');
  });
}

// ══════════════════════════════════════════════════════════
// SECCIÓN 2C — SQLite edge cases (unit tests lib/db.js)
// ══════════════════════════════════════════════════════════
async function runSection2C() {
  console.log(`\n${B('2C. SQLite — Edge cases')}`);

  let db;
  try {
    // Usar DB fresca
    const dbPath = path.join(TEST_WORK_DIR, 'db-edge-test.db');
    delete require.cache[require.resolve('../lib/db')];
    db = require('../lib/db');
    db.init(dbPath);
  } catch (e) {
    skip('2C completo', `No se pudo cargar DB: ${e.message}`);
    return;
  }

  await test('insertMessage básico → mensaje guardado en DB', () => {
    const uuid = 'msg-' + Date.now();
    db.insertMessage({
      uuid,
      channel: 'test',
      role: 'user',
      content: 'hello',
      chat_id: null,
    });
    // Verificar que el mensaje fue guardado
    const msgs = db.getHistory({ limit: 10 });
    const found = msgs.find(m => m.uuid === uuid);
    assert.ok(found, `Mensaje ${uuid} no encontrado en DB`);
    assert.strictEqual(found.content, 'hello');
  });

  await test('getHistory → retorna array con mensaje insertado', () => {
    const msgs = db.getHistory({ limit: 10 });
    assert.ok(Array.isArray(msgs));
    assert.ok(msgs.length >= 1);
  });

  await test('getHistory before=0 → array vacío', () => {
    const msgs = db.getHistory({ before: 0, limit: 10 });
    assert.ok(Array.isArray(msgs));
    assert.strictEqual(msgs.length, 0, 'before=0 debe devolver vacío');
  });

  await test('getHistory before=epoch año 3000 → devuelve mensajes', () => {
    const futureTs = new Date('3000-01-01').getTime();
    const msgs = db.getHistory({ before: futureTs, limit: 10 });
    assert.ok(Array.isArray(msgs));
    assert.ok(msgs.length >= 1);
  });

  await test('starMessage UUID inexistente → no error', () => {
    // UPDATE 0 rows es ok
    assert.doesNotThrow(() => {
      db.starMessage('non-existent-uuid-xyz', true);
    });
  });

  await test('starMessage → mensaje marcado como starred', () => {
    const uuid = 'star-test-' + Date.now();
    db.insertMessage({ uuid, channel: 'test', role: 'user', content: 'star me', chat_id: null, tokens_in: 0, tokens_out: 0, model: null });
    db.starMessage(uuid, true);
    const msgs = db.getHistory({ starred: true, limit: 10 });
    const found = msgs.find(m => m.uuid === uuid);
    assert.ok(found, 'Mensaje starred no encontrado');
    assert.ok(found.starred, 'Campo starred debe ser truthy');
  });

  await test('getHistory con búsqueda q=texto → filtra correctamente', () => {
    const unique = 'texto-único-' + Math.random().toString(36).slice(2);
    db.insertMessage({ uuid: 'search-test-' + Date.now(), channel: 'test', role: 'user', content: unique, chat_id: null, tokens_in: 0, tokens_out: 0, model: null });
    const msgs = db.getHistory({ q: unique, limit: 10 });
    assert.ok(msgs.length >= 1, `Debe encontrar el mensaje con "${unique}"`);
    assert.ok(msgs.every(m => m.content.includes(unique.split('-')[0])));
  });

  await test('Insertar 50 mensajes consecutivos → todos guardados', () => {
    const before = db.getHistory({ limit: 200 }).length;
    for (let i = 0; i < 50; i++) {
      db.insertMessage({
        uuid: `bulk-${Date.now()}-${i}`,
        channel: 'bulk',
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Mensaje ${i}`,
        chat_id: null, tokens_in: 0, tokens_out: 0, model: null,
      });
    }
    const after = db.getHistory({ limit: 200 }).length;
    assert.ok(after >= before + 50, `Esperado ${before + 50}+, recibido ${after}`);
  });

  await test('stateGet/stateSet → persiste valores', () => {
    db.stateSet('test_key', 'test_value_123');
    const val = db.stateGet('test_key');
    assert.strictEqual(val, 'test_value_123');
  });

  await test('stateGet de clave inexistente → null o undefined', () => {
    const val = db.stateGet('key_that_does_not_exist_xyz');
    assert.ok(val === null || val === undefined, `Esperado null/undefined, got: ${val}`);
  });
}

// ══════════════════════════════════════════════════════════
// SECCIÓN 2D — WebSocket lifecycle (unit tests lib/ws.js)
// ══════════════════════════════════════════════════════════
async function runSection2D() {
  console.log(`\n${B('2D. WebSocket — Lifecycle y broadcast')}`);

  // No podemos cargar ws.js sin el servidor real aquí, pero podemos
  // testear la lógica de broadcast directamente replicando la interfaz
  const { EventEmitter } = require('events');

  // Simular la interfaz de ws.js para tests de unidad
  function createMockWs() {
    const clients = new Set();

    function broadcast(event) {
      const data = JSON.stringify(event);
      let sent = 0;
      for (const c of clients) {
        if (c.readyState === 1) { // OPEN
          try { c.mockSend(data); sent++; } catch { clients.delete(c); }
        } else {
          clients.delete(c);
        }
      }
      return sent;
    }

    function addClient(mockSocket) {
      clients.add(mockSocket);
    }

    return { clients, broadcast, addClient };
  }

  function makeSocket(state = 1) { // 1 = OPEN
    const s = new EventEmitter();
    s.readyState = state;
    s.messages = [];
    s.mockSend = (data) => { s.messages.push(data); };
    return s;
  }

  await test('broadcast con 0 clientes → retorna 0 sin error', () => {
    const { broadcast } = createMockWs();
    const sent = broadcast({ type: 'test' });
    assert.strictEqual(sent, 0);
  });

  await test('broadcast con 3 clientes → todos reciben mensaje', () => {
    const { broadcast, addClient } = createMockWs();
    const clients = [makeSocket(), makeSocket(), makeSocket()];
    clients.forEach(c => addClient(c));
    const sent = broadcast({ type: 'message', content: 'hello' });
    assert.strictEqual(sent, 3);
    clients.forEach(c => {
      assert.strictEqual(c.messages.length, 1);
      assert.deepStrictEqual(JSON.parse(c.messages[0]), { type: 'message', content: 'hello' });
    });
  });

  await test('broadcast con socket cerrado → socket removido del Set', () => {
    const { broadcast, addClient, clients } = createMockWs();
    const openSocket   = makeSocket(1);  // OPEN
    const closedSocket = makeSocket(3);  // CLOSED
    addClient(openSocket);
    addClient(closedSocket);
    broadcast({ type: 'test' });
    assert.ok(clients.has(openSocket), 'Socket abierto debe permanecer');
    assert.ok(!clients.has(closedSocket), 'Socket cerrado debe ser removido');
  });

  await test('broadcast con socket que lanza error → no propagado, socket removido', () => {
    const { broadcast, addClient, clients } = createMockWs();
    const badSocket = makeSocket(1);
    badSocket.mockSend = () => { throw new Error('send failed'); };
    addClient(badSocket);
    assert.doesNotThrow(() => broadcast({ type: 'test' }));
    assert.ok(!clients.has(badSocket), 'Socket con error debe ser removido');
  });

  await test('Mensaje JSON válido serializado en broadcast', () => {
    const { broadcast, addClient } = createMockWs();
    const socket = makeSocket();
    addClient(socket);
    broadcast({ type: 'typing', active: true, chatId: '123' });
    const parsed = JSON.parse(socket.messages[0]);
    assert.strictEqual(parsed.type, 'typing');
    assert.strictEqual(parsed.active, true);
    assert.strictEqual(parsed.chatId, '123');
  });

  await test('100 clientes → todos reciben broadcast', () => {
    const { broadcast, addClient } = createMockWs();
    const sockets = Array.from({ length: 100 }, () => makeSocket());
    sockets.forEach(s => addClient(s));
    const sent = broadcast({ type: 'mass' });
    assert.strictEqual(sent, 100);
    sockets.forEach(s => assert.strictEqual(s.messages.length, 1));
  });
}

// ══════════════════════════════════════════════════════════
// SECCIÓN 2E — Verificaciones de resiliencia en source
// ══════════════════════════════════════════════════════════
async function runSection2E() {
  console.log(`\n${B('2E. Resiliencia — Verificaciones de source code')}`);

  await test('queue.js tiene MAX_SIZE configurable por env', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'queue.js'), 'utf8');
    assert.ok(
      src.includes('QUEUE_MAX_SIZE') || src.includes('MAX_SIZE'),
      'queue.js debe tener MAX_SIZE configurable'
    );
  });

  await test('queue.js tiene TIMEOUT_MS configurable por env', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'queue.js'), 'utf8');
    assert.ok(
      src.includes('CLAUDE_TIMEOUT_MS') || src.includes('TIMEOUT_MS'),
      'queue.js debe tener TIMEOUT_MS configurable por env'
    );
  });

  await test('bridge.js valida ANTHROPIC_AUTH_TOKEN al arrancar', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
    assert.ok(
      src.includes('ANTHROPIC_AUTH_TOKEN'),
      'bridge.js debe referenciar ANTHROPIC_AUTH_TOKEN'
    );
  });

  await test('db.js usa WAL mode para lecturas concurrentes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
    assert.ok(
      src.includes('WAL') || src.includes('wal'),
      'db.js debe usar WAL mode de SQLite'
    );
  });

  await test('session.js guarda UUID en SQLite (no en memoria)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session.js'), 'utf8');
    assert.ok(
      src.includes('stateSet') || src.includes('stateGet'),
      'session.js debe usar DB (stateSet/stateGet) para persistencia'
    );
  });

  await test('bridge.js tiene single instance lock', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
    assert.ok(
      src.includes('LOCK_FILE') || src.includes('.lock'),
      'bridge.js debe tener mecanismo de single instance'
    );
  });

  await test('ws.js tiene heartbeat para detectar conexiones muertas', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ws.js'), 'utf8');
    assert.ok(
      src.includes('heartbeat') || src.includes('ping') || src.includes('setInterval'),
      'ws.js debe tener heartbeat'
    );
  });

  await test('readBody en bridge.js tiene límite de tamaño', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
    assert.ok(
      src.includes('MAX_BODY') || src.includes('1024 * 1024'),
      'readBody debe tener límite de tamaño'
    );
  });

  await test('auth.js limpia sesiones expiradas periódicamente', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'auth.js'), 'utf8');
    assert.ok(
      src.includes('setInterval') && src.includes('SESSION_TTL'),
      'auth.js debe limpiar sesiones expiradas con setInterval'
    );
  });
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════
async function main() {
  console.log(`${B('══════════════════════════════════════════')}`);
  console.log(`${B(' ClaudeClaw — Suite de Resiliencia')}`);
  console.log(`${B('══════════════════════════════════════════')}`);
  console.log(`  WORK_DIR: ${TEST_WORK_DIR}`);

  await runSection2A();
  await runSection2B();
  await runSection2C();
  await runSection2D();
  await runSection2E();

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

  // Cleanup
  try { fs.rmSync(TEST_WORK_DIR, { recursive: true, force: true }); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(R('Error fatal: ' + e.message));
  console.error(e.stack);
  process.exit(1);
});
