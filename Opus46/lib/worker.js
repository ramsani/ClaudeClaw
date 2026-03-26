'use strict';
/**
 * Worker autónomo ClaudeClaw
 * Ejecuta tareas de novaclaw_tasks en background.
 * Siempre corriendo vía PM2. Proceso independiente del bridge.
 */

// Cargar .env
const envPath = require('path').join(__dirname, '..', '..', '.env');
try {
  require('fs').readFileSync(envPath, 'utf8').split('\n').forEach(l => {
    const [k, ...v] = l.split('=');
    if (k && !k.startsWith('#') && !(k.trim() in process.env))
      process.env[k.trim()] = v.join('=').trim();
  });
} catch {}

const { spawn }    = require('child_process');
const db           = require('./pgdb');
const POLL_MS      = parseInt(process.env.WORKER_POLL_MS  || '8000');
const HB_MS        = parseInt(process.env.WORKER_HB_MS   || '10000');
const TASK_TIMEOUT = parseInt(process.env.WORKER_TIMEOUT_MS || '300000'); // 5 min
const TG_TOKEN     = process.env.TG_TOKEN;
const ALLOWED_ID   = process.env.ALLOWED_ID;
const WORK_DIR     = process.env.WORK_DIR || require('os').homedir() + '/0Proyectos/MyClaw';
const CLAUDE_ENV   = { ...process.env, HOME: require('os').homedir() };
const WORKER_PID   = process.pid;
let currentTaskId  = null; // para graceful shutdown

// ── Telegram directo (inicio de tarea + fallback + errores) ──
async function sendTelegram(chatId, text) {
  if (!chatId || !TG_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch(e) { console.error('[worker] telegram error:', e.message); }
}


// ── Ejecutar Claude sin MCP (rápido, aislado) ─────────────────
function executeWithClaude(prompt, context) {
  return new Promise((resolve, reject) => {
    const fullPrompt = context ? `${context}\n\n---\n${prompt}` : prompt;

    const args = [
      '--print', '--verbose', '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--strict-mcp-config', // sin MCP servers = rápido y aislado
    ];

    const proc = spawn('claude', args, {
      cwd: WORK_DIR,
      env: CLAUDE_ENV,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let result = '';
    let buffer = '';

    proc.stdin.write(fullPrompt + '\n');
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('timeout'));
    }, TASK_TIMEOUT);

    proc.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result' && ev.result) result = ev.result;
          if (ev.type === 'assistant') {
            const content = ev.message?.content || [];
            content.forEach(b => {
              if (b.type === 'tool_use') console.log(`[worker] tool: ${b.name}`);
            });
          }
        } catch {}
      }
    });

    proc.stderr.on('data', d => process.stderr.write(d));

    proc.on('close', code => {
      clearTimeout(timer);
      if (result) resolve(result);
      else if (code === 0) resolve('(sin resultado)');
      else reject(new Error(`exit code ${code}`));
    });

    proc.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// ── Procesar una tarea ────────────────────────────────────────
async function procesarTarea(task) {
  currentTaskId = task.id;
  console.log(`[worker] tarea #${task.id} [${task.type}]: ${task.prompt.slice(0, 60)}...`);

  // Notificar inicio — directo (liviano, no necesita despertar MyClaw)
  if (task.notify_telegram) {
    await sendTelegram(
      task.telegram_chat_id || ALLOWED_ID,
      `⚡ *Tarea #${task.id} iniciada*\n_${task.prompt.slice(0, 80)}_`
    );
  }

  // Heartbeat por tarea mientras trabaja
  const hbInterval = setInterval(() => db.heartbeatTask(task.id).catch(() => {}), HB_MS);

  try {
    const result = await executeWithClaude(task.prompt, task.context);
    clearInterval(hbInterval);

    await db.completeTask(task.id, result);
    console.log(`[worker] tarea #${task.id} completada`);

    if (task.notify_telegram) {
      await sendTelegram(
        task.telegram_chat_id || ALLOWED_ID,
        `✅ *Tarea #${task.id} completada*\n\n_${task.prompt.slice(0, 80)}_\n\n${result.slice(0, 500)}`
      );
    }

    // Cron recurrente: programar próxima ejecución
    if (task.type === 'cron' && task.cron_expr) {
      await db.scheduleNextCronRun(task.id, task.cron_expr);
      console.log(`[worker] cron #${task.id} reprogramado`);
    }

  } catch (err) {
    clearInterval(hbInterval);
    const canRetry = task.retries < task.max_retries;
    await db.failTask(task.id, err.message, canRetry);
    console.error(`[worker] tarea #${task.id} falló (retry=${canRetry}):`, err.message);

    if (!canRetry && task.notify_telegram) {
      await sendTelegram(
        task.telegram_chat_id || ALLOWED_ID,
        `❌ *Tarea #${task.id} fallida* (${task.retries + 1} intentos)\n_${task.prompt.slice(0, 80)}_\n\nError: ${err.message}`
      );
    }
  } finally {
    currentTaskId = null;
  }
}

// ── Loop principal ────────────────────────────────────────────
async function workerLoop() {
  while (true) {
    try {
      const task = await db.claimNextTask(WORKER_PID);
      if (task) {
        await procesarTarea(task);
        continue; // no esperar si hay más tareas en cola
      }
    } catch (err) {
      console.error('[worker] error en loop:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// ── Revisión proactiva cada 3h (solo 8:00–20:00 hora México) ──
// NO toca la tabla actions — n8n ya gestiona recordatorios.
// Solo analiza qué tareas pendientes puede resolver Claude
// y propone ayuda concreta al usuario vía Telegram.
async function proactiveReview() {
  const hora = new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', hour: 'numeric', hour12: false
  });
  if (parseInt(hora) < 8 || parseInt(hora) >= 20) {
    console.log(`[worker] proactiveReview omitida — hora=${hora} fuera de 8-20`);
    return;
  }

  try {
    const { rows } = await db.pool.query(`
      SELECT title, content, action_type FROM actions
      WHERE status='active' ORDER BY created_at DESC LIMIT 20
    `);
    if (!rows.length) return;

    const lista = rows.map((a, i) =>
      `${i + 1}. [${a.action_type || 'tarea'}] ${a.title}${a.content ? ': ' + a.content.slice(0, 80) : ''}`
    ).join('\n');

    const prompt = `Tienes acceso a la lista de tareas pendientes del usuario. Tu trabajo es identificar SOLO las que tú, como IA, puedes resolver de verdad sin intervención humana (investigar, redactar, analizar, escribir código, buscar información, hacer cálculos, etc.).

Lista de tareas pendientes:
${lista}

Responde ÚNICAMENTE con un mensaje corto para enviar por Telegram. Si hay tareas donde puedes ayudar concretamente, menciona máximo 3, sé específico en qué harías exactamente. Si ninguna es delegable a una IA, di "Tus tareas actuales requieren acción directa tuya, no tengo trabajo computacional que hacer por ti ahora."

No ejecutes nada. Solo propón.`;

    const result = await executeWithClaude(prompt, null, WORK_DIR);
    if (result && result.trim()) {
      await sendTelegram(ALLOWED_ID, `🤖 *Revisión proactiva:*\n\n${result.trim()}`);
      console.log('[worker] revisión proactiva enviada');
    }
  } catch(e) { console.error('[worker] proactiveReview:', e.message); }
}

// ── Graceful shutdown ─────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[worker] ${signal} recibido, cerrando limpiamente...`);
  if (currentTaskId) {
    try {
      await db.pool.query(
        `UPDATE novaclaw_tasks SET status='pending', retries=retries+1,
         error_msg='Worker shutdown', run_at=NOW() + INTERVAL '5 seconds'
         WHERE id=$1 AND status='running'`,
        [currentTaskId]
      );
      console.log(`[worker] tarea #${currentTaskId} devuelta a pending`);
    } catch {}
  }
  try { await db.pool.end(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Inicio ────────────────────────────────────────────────────
async function main() {
  console.log(`[worker] iniciando PID=${WORKER_PID}`);
  await db.init();

  // Resetear tareas stuck de crashes anteriores
  const stuck = await db.resetStuckTasks();
  if (stuck.length) console.log(`[worker] ${stuck.length} tareas stuck reseteadas`);

  // Heartbeat global: escribe en novaclaw_state cada HB_MS
  // Permite a /api/worker/status saber si el worker está vivo incluso sin tareas
  await db.stateSet('worker_heartbeat', String(Date.now()));
  await db.stateSet('worker_pid', String(WORKER_PID));
  setInterval(async () => {
    try { await db.stateSet('worker_heartbeat', String(Date.now())); } catch {}
  }, HB_MS);

  // Revisión proactiva cada 3 horas (solo 8:00–20:00 México)
  setInterval(proactiveReview, 3 * 60 * 60_000);
  proactiveReview(); // primera vez al arrancar (respeta el horario)

  // Loop principal
  workerLoop(); // no await — corre indefinidamente
  console.log(`[worker] listo, polling cada ${POLL_MS}ms`);
}

main().catch(e => { console.error('[worker] fatal:', e); process.exit(1); });
