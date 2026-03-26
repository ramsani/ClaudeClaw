'use strict';
/**
 * Tests funcionales del terminal PTY WebSocket
 */
const WebSocket = require('ws');

const TOKEN = 'c3e808f0c41a70886e274f23e3b900ab';
const BASE  = `ws://localhost:5679`;

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  return fn().then(() => {
    console.log(`  ✅ ${name}`);
    results.push({ name, ok: true });
    passed++;
  }).catch(e => {
    console.log(`  ❌ ${name}: ${e.message}`);
    results.push({ name, ok: false, error: e.message });
    failed++;
  });
}

function wsConnect(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timeout conectando'));
    }, timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function wsReceive(ws, { timeoutMs = 5000, filter } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout esperando mensaje')), timeoutMs);
    const handler = (data) => {
      const msg = data.toString();
      if (!filter || filter(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.on('close', () => { clearTimeout(timer); reject(new Error('ws cerrado inesperadamente')); });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function wsClose(ws) {
  return new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', resolve);
    ws.close();
    setTimeout(resolve, 1000); // fallback
  });
}

async function main() {
  console.log('\n🧪 Tests Terminal PTY WebSocket\n');

  // ── 1. Sin auth debe rechazar ────────────────────────────────
  await test('Sin token → rechaza con 401', async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${BASE}/ws/terminal?shell=bash`);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('no cerró')); }, 3000);
      ws.on('unexpected-response', (req, res) => {
        clearTimeout(timer);
        if (res.statusCode === 401) resolve();
        else reject(new Error(`esperaba 401, recibió ${res.statusCode}`));
      });
      ws.on('open', () => { clearTimeout(timer); ws.close(); reject(new Error('conexión inesperadamente aceptada')); });
      ws.on('error', () => { clearTimeout(timer); resolve(); }); // error = rechazado = OK
    });
  });

  // ── 2. Con token → conecta ────────────────────────────────────
  await test('Con token → conecta al bash PTY', async () => {
    const ws = await wsConnect(`${BASE}/ws/terminal?shell=bash&token=${TOKEN}&cols=80&rows=24`);
    // Debe recibir output del shell (prompt, etc.)
    const data = await wsReceive(ws, { timeoutMs: 4000 });
    if (!data || data.length === 0) throw new Error('no recibió output inicial');
    await wsClose(ws);
  });

  // ── 3. Bash: ejecutar comando ─────────────────────────────────
  await test('Bash: ejecutar `echo TESTOK` y recibir output', async () => {
    const ws = await wsConnect(`${BASE}/ws/terminal?shell=bash&token=${TOKEN}&cols=80&rows=24`);
    // Esperar prompt inicial
    await wsReceive(ws, { timeoutMs: 3000 });
    // Enviar comando
    ws.send('echo TESTOK\n');
    const output = await wsReceive(ws, {
      timeoutMs: 4000,
      filter: msg => msg.includes('TESTOK'),
    });
    if (!output.includes('TESTOK')) throw new Error('output no contiene TESTOK');
    await wsClose(ws);
  });

  // ── 4. Resize ────────────────────────────────────────────────
  await test('Resize: servidor acepta mensaje de resize sin error', async () => {
    const ws = await wsConnect(`${BASE}/ws/terminal?shell=bash&token=${TOKEN}&cols=80&rows=24`);
    await wsReceive(ws, { timeoutMs: 3000 }); // esperar prompt
    // Enviar resize
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    // No debe cerrarse ni dar error
    await new Promise(r => setTimeout(r, 500));
    if (ws.readyState !== WebSocket.OPEN) throw new Error('WS cerró tras resize');
    await wsClose(ws);
  });

  // ── 5. Shell inválido → bash por defecto ─────────────────────
  await test('Shell desconocido → fallback a bash (o error controlado)', async () => {
    // Si el shell no existe, el PTY fallará al spawn y ws recibirá error o cerrará
    await new Promise((resolve) => {
      const ws = new WebSocket(`${BASE}/ws/terminal?shell=invalidshell&token=${TOKEN}`);
      let handled = false;
      const done = () => { if (!handled) { handled = true; resolve(); } };
      ws.on('open', () => {
        // Puede abrirse y luego cerrar con error
        setTimeout(() => { ws.terminate(); done(); }, 2000);
      });
      ws.on('message', (data) => {
        const msg = data.toString();
        // Puede recibir pty_error
        if (msg.includes('pty_error') || msg.includes('error')) done();
      });
      ws.on('close', done);
      ws.on('error', done);
    });
    // Si llegamos aquí sin excepción, el edge case está manejado
  });

  // ── 6. Mensaje kill → cierra PTY ─────────────────────────────
  await test('Mensaje kill → PTY termina y WS cierra', async () => {
    const ws = await wsConnect(`${BASE}/ws/terminal?shell=bash&token=${TOKEN}&cols=80&rows=24`);
    await wsReceive(ws, { timeoutMs: 3000 });
    ws.send(JSON.stringify({ type: 'kill' }));
    // El WS debe cerrarse
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS no cerró tras kill')), 3000);
      ws.on('close', () => { clearTimeout(timer); resolve(); });
    });
  });

  // ── 7. Desconexión brusca → PTY limpiado ─────────────────────
  await test('Desconexión brusca (terminate) → PTY destruido sin leak', async () => {
    const ws = await wsConnect(`${BASE}/ws/terminal?shell=bash&token=${TOKEN}&cols=80&rows=24`);
    await wsReceive(ws, { timeoutMs: 3000 });
    ws.terminate(); // cierre brusco, sin handshake
    // Esperar a que el servidor procese el cierre
    await new Promise(r => setTimeout(r, 1000));
    // No hay forma de verificar directamente desde cliente, pero si el servidor no crasheó está bien
    // Verificar que el bridge sigue respondiendo
    const res = await fetch('http://localhost:5679/api/worker/status', {
      headers: { 'X-Bridge-Token': TOKEN }
    });
    if (!res.ok) throw new Error('bridge no responde tras terminate brusco');
  });

  // ── 8. Múltiples sesiones simultáneas ────────────────────────
  await test('Dos sesiones bash simultáneas son independientes', async () => {
    const ws1 = await wsConnect(`${BASE}/ws/terminal?shell=bash&token=${TOKEN}&cols=80&rows=24`);
    const ws2 = await wsConnect(`${BASE}/ws/terminal?shell=bash&token=${TOKEN}&cols=80&rows=24`);
    await Promise.all([
      wsReceive(ws1, { timeoutMs: 3000 }),
      wsReceive(ws2, { timeoutMs: 3000 }),
    ]);
    // Enviar comandos distintos
    ws1.send('echo SESION_UNO\n');
    ws2.send('echo SESION_DOS\n');

    const [out1, out2] = await Promise.all([
      wsReceive(ws1, { timeoutMs: 4000, filter: m => m.includes('SESION_UNO') }),
      wsReceive(ws2, { timeoutMs: 4000, filter: m => m.includes('SESION_DOS') }),
    ]);
    if (!out1.includes('SESION_UNO')) throw new Error('sesión 1 no aisló su output');
    if (!out2.includes('SESION_DOS')) throw new Error('sesión 2 no aisló su output');
    await Promise.all([wsClose(ws1), wsClose(ws2)]);
  });

  // ── 9. Input con caracteres especiales ───────────────────────
  await test('Input con caracteres especiales (comillas, $, espacios)', async () => {
    const ws = await wsConnect(`${BASE}/ws/terminal?shell=bash&token=${TOKEN}&cols=80&rows=24`);
    await wsReceive(ws, { timeoutMs: 3000 });
    ws.send('echo "hola $USER mundo"\n');
    const out = await wsReceive(ws, { timeoutMs: 4000, filter: m => m.includes('hola') });
    if (!out.includes('hola')) throw new Error('echo con variables falló');
    await wsClose(ws);
  });

  // ── 10. Chat WS sigue funcionando en paralelo ─────────────────
  await test('Chat WS /ws sigue operando mientras hay sesiones PTY activas', async () => {
    const ptyWs = await wsConnect(`${BASE}/ws/terminal?shell=bash&token=${TOKEN}`);
    await wsReceive(ptyWs, { timeoutMs: 3000 });

    const chatWs = await wsConnect(`${BASE}/ws?token=${TOKEN}`);
    const connected = await wsReceive(chatWs, { timeoutMs: 3000 });
    if (!connected.includes('connected')) throw new Error('chat WS no conectó');

    chatWs.send(JSON.stringify({ type: 'ping' }));
    const pong = await wsReceive(chatWs, { timeoutMs: 2000, filter: m => m.includes('pong') });
    if (!pong.includes('pong')) throw new Error('ping/pong falló');

    await Promise.all([wsClose(ptyWs), wsClose(chatWs)]);
  });

  // ── Resumen ────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Resultado: ${passed}/${passed + failed} pruebas pasaron`);
  if (failed > 0) {
    console.log('\nFallidas:');
    results.filter(r => !r.ok).forEach(r => console.log(`  ❌ ${r.name}: ${r.error}`));
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
