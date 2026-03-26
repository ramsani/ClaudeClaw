# Reporte Técnico: Sesiones Persistentes en Claude Code CLI

## 1. Cómo funciona `--continue` internamente

### Mecanismo real
`--continue` NO mantiene un proceso vivo. Hace lo siguiente al arrancar:

1. Lee el archivo de sesión más reciente del directorio del proyecto actual:
   - `~/.claude/projects/<hash-del-cwd>/<session-uuid>.jsonl`
   - Cada sesión es un archivo JSONL (una línea JSON por evento: mensajes user, assistant, tool calls, results)
2. Carga ese historial completo en memoria como contexto
3. Agrega el nuevo mensaje del usuario
4. Llama a la API de Anthropic con todo el historial
5. Escribe los nuevos eventos al mismo `.jsonl` y termina

### Paths reales en tu sistema
```
~/.claude/projects/                          # directorio raíz de sesiones por proyecto
~/.claude/projects/<hash>/<uuid>.jsonl       # sesión individual
~/.claude/history.jsonl                      # log global de actividad
~/.claude/sessions/                          # sesiones activas (6 entries en tu sistema)
```

El JSONL de sesión tiene campos: `type`, `operation`, `timestamp`, `sessionId` (UUID v4).
El `history.jsonl` global tiene: `display`, `pastedContents`, `timestamp`, `project`, `sessionId`.

### Flags relevantes confirmados
```
--continue / -c          Lee y continua la sesión más reciente del CWD
--resume <uuid>          Resume por session UUID específico
--session-id <uuid>      Usa un UUID específico (permite forzar la misma sesión)
--fork-session           Al resumir, crea nuevo session ID en vez de reusar el original
--no-session-persistence No guarda sesión en disco (solo --print)
```

### ¿Es thread-safe?
**NO.** No hay file locking entre procesos. Si dos instancias de `claude --continue` se ejecutan simultáneamente:
- Ambas leen el mismo `.jsonl` al inicio
- Ambas escriben al mismo archivo en paralelo
- El resultado es corrupción del historial y respuestas incoherentes
- La desktop app de Claude Code y el bot estarían en conflicto constante

---

## 2. ¿Existe modo servidor/daemon?

**No existe un modo servidor nativo en Claude Code CLI.** No hay flags como `--serve`, `--daemon`, `--socket`, ni nada equivalente.

Lo que SÍ existe y es relevante:
- `--input-format stream-json`: acepta mensajes continuos por stdin en formato JSON estructurado (incluye imágenes en base64). Esto permite feeds de múltiples mensajes en UN proceso, pero ese proceso termina cuando se cierra stdin.
- `--output-format stream-json`: emite eventos en tiempo real (tool calls, assistant chunks, `result` final)
- `--replay-user-messages`: re-emite mensajes de entrada en stdout para acknowledgment (útil con stream-json bidireccional)

El patrón `--input-format stream-json` es la forma más cercana a un "modo pipe continuo", pero sigue siendo single-session y single-process.

---

## 3. Proyectos existentes que resuelven esto

### Tier 1: Más relevantes

**godagoo/claude-telegram-relay** (322 stars)
- URL: https://github.com/godagoo/claude-telegram-relay
- Stack: Bun + TypeScript + grammy + Supabase
- Solución: Guarda `sessionId` en archivo JSON local. Cada mensaje hace `spawn('claude', ['--resume', sessionId, ...])`. Incluye lock file para instancia única.
- Código clave en `src/relay.ts`: `loadSession()` / `saveSession()` con `{ sessionId, lastActivity }`
- Daemon via `launchagent.plist` (macOS) y `claude-relay.service` (systemd)
- **Problema**: sigue spawneando proceso por mensaje, comparte sesión via `--resume <uuid>`

**JinchengGao-Infty/LinkBuddy** (4 stars)
- URL: https://github.com/JinchengGao-Infty/LinkBuddy
- Stack: Turborepo + Claude Code SDK (no CLI directo) + SQLite + grammy
- Arquitectura: `agent` package usa el SDK programático de Claude Code, no el CLI
- Telegram → Gateway → Claude Code SDK Agent → MCP Servers
- **Esta es la arquitectura más robusta**: evita completamente el problema de sesiones JSONL

**lustan3216/claudeclaw** (2 stars)
- URL: https://github.com/lustan3216/claudeclaw
- Reescritura en Go del ClaudeClaw original (tu proyecto)
- Múltiples sesiones paralelas via Telegram Topics
- Cada topic = sesión independiente de Claude
- Plugin instalable: `claude plugin install lustan3216/claudeclaw`

---

## 4. Las 3 Mejores Opciones Técnicas

### OPCIÓN 1 (Recomendada): Cola serializada + `--resume <session-id>` fijo

Arquitectura: el bridge Node.js gestiona UNA cola de mensajes. Los mensajes se procesan en serie, cada uno con `--resume <uuid>` apuntando al mismo UUID. La desktop app de Claude Code también usa ese mismo UUID via `/resume`.

**Viabilidad: ALTA. Implementable hoy, mínimo cambio.**

```javascript
// bridge-v6.js — Cola serializada con session ID fijo

const SESSION_FILE = path.join(os.homedir(), '.claude', 'bridge-session.json');
let sessionId = null;
let queue = [];
let processing = false;

function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    sessionId = data.sessionId;
    console.log(`Sesión cargada: ${sessionId}`);
  } catch {
    sessionId = null; // primera vez, claude creará una nueva
  }
}

function saveSession(id) {
  sessionId = id;
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id, updated: new Date().toISOString() }));
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  const { message, chatId, resolve, reject } = queue.shift();

  try {
    const result = await runClaude(message, chatId);
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    processing = false;
    processQueue(); // siguiente mensaje
  }
}

function askClaude(message, chatId) {
  return new Promise((resolve, reject) => {
    queue.push({ message, chatId, resolve, reject });
    processQueue();
  });
}

function runClaude(message, chatId) {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--verbose', '--output-format', 'stream-json',
                  '--dangerously-skip-permissions'];

    // Primera vez: --continue para tomar la sesión activa de la desktop app
    // Subsiguientes: --resume <uuid> para sesión exacta
    if (sessionId) {
      args.push('--resume', sessionId);
    } else {
      args.push('--continue');
    }

    args.push(message);

    const proc = spawn('claude', args, { env: CLAUDE_ENV, cwd: WORK_DIR });

    let buffer = '', result = '', capturedSessionId = null;
    const seenTools = new Set();

    proc.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          // Capturar session ID del primer evento
          if (event.sessionId && !capturedSessionId) {
            capturedSessionId = event.sessionId;
          }
          if (event.type === 'result') result = String(event.result || '').trim();
          // tool calls progress...
        } catch {}
      }
    });

    proc.on('close', code => {
      if (capturedSessionId && capturedSessionId !== sessionId) {
        saveSession(capturedSessionId);
      }
      resolve(result || `Exit ${code}`);
    });

    proc.on('error', reject);
  });
}

loadSession();
```

**Limitación crítica**: la desktop app de Claude Code y el bot NO pueden usar la sesión simultáneamente. La cola garantiza que solo uno escribe a la vez, pero si la desktop app está activa mientras llega un mensaje de Telegram, habrá conflicto de escritura en el JSONL.

**Workaround**: reservar un session ID exclusivo para el bot (no compartir con la desktop). Contexto compartido = via CLAUDE.md o archivos en el workspace, no via session ID.

---

### OPCIÓN 2 (Más robusta): Claude Code SDK programático

El paquete `@anthropic-ai/claude-code` expone un SDK JavaScript/TypeScript además del CLI. Es la misma librería que usa LinkBuddy.

```javascript
// usando el SDK directamente (requiere inspeccionar el API interno)
// El SDK mantiene el proceso vivo y gestiona el historial en memoria

import { query } from '@anthropic-ai/claude-code';

// Mantener conversationHistory en memoria del proceso Node.js
// No depende de archivos JSONL en absoluto
// Thread-safe porque Node.js es single-threaded
// Múltiples clientes comparten el mismo array en memoria

const conversationHistory = [];

async function handleMessage(userMessage) {
  // El SDK acepta options.continue_conversation o similar
  const response = await query({
    prompt: userMessage,
    options: { /* session config */ }
  });
  return response;
}
```

**Nota**: el API interno del SDK no está completamente documentado públicamente. LinkBuddy es la referencia de implementación: https://github.com/JinchengGao-Infty/LinkBuddy/tree/main/packages/agent

---

### OPCIÓN 3: `--input-format stream-json` con proceso persistente

Mantener UN proceso Claude vivo que consume mensajes de stdin indefinidamente. El bridge encola mensajes en stdin y lee de stdout.

```javascript
// Un proceso claude persistente consumiendo stdin
const claudeProc = spawn('claude', [
  '--print',
  '--continue',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--dangerously-skip-permissions',
], { env: CLAUDE_ENV, cwd: WORK_DIR, stdio: ['pipe', 'pipe', 'pipe'] });

// Enviar mensaje
function sendMessage(text) {
  const msg = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text }
  }) + '\n';
  claudeProc.stdin.write(msg);
}

// El proceso continua vivo entre mensajes
// La sesión está en memoria — zero JSONL conflicts
```

**Problema**: Claude Code CLI en `--print` mode con `--input-format stream-json` puede o no soportar múltiples rounds de Q&A sin terminar. Requiere prueba empírica. Si el proceso termina al completar cada respuesta, esta opción no aplica.

---

## 5. Recomendación Final

**Para tu caso de uso exacto (desktop app + Telegram bot simultáneos):**

La respuesta honesta es que **compartir una sesión entre desktop app y bot simultáneamente es arquitectónicamente problemático** con el CLI actual. El archivo JSONL no tiene locking concurrente.

**La solución más pragmática:**

1. **NO compartir sesión** entre desktop y bot. Son sesiones separadas.
2. **Compartir contexto** via `CLAUDE.md` en el workspace y archivos de memoria en `MyClaw/`.
3. **El bot usa su propia sesión fija** (`--resume <uuid>` consistente entre llamadas).
4. La desktop app tiene su propia sesión de trabajo.
5. Ambos operan sobre el mismo directorio (`MyClaw/`) y leen los mismos archivos.

Esto es lo que hace `tstockham96/claw-kit` (sin daemons, sin session hijacking, contexto compartido via markdown).

**Si insistes en sesión realmente compartida**: usa LinkBuddy como referencia e implementa vía SDK programático, manteniendo el historial en SQLite en el proceso Node.js, y pasándolo a cada llamada al SDK como contexto explícito.

---

## Referencias

- `godagoo/claude-telegram-relay`: https://github.com/godagoo/claude-telegram-relay (322 stars, patrón de referencia)
- `JinchengGao-Infty/LinkBuddy`: https://github.com/JinchengGao-Infty/LinkBuddy (SDK approach, más robusto)
- `lustan3216/claudeclaw`: https://github.com/lustan3216/claudeclaw (Go rewrite de tu proyecto)
- `tstockham96/claw-kit`: https://github.com/tstockham96/claw-kit (sin daemons, contexto via markdown)
- `Lordymine/aurelia`: https://github.com/Lordymine/aurelia (Go, multi-agent, memory semántica)
- Sesiones locales: `~/.claude/projects/<hash>/<uuid>.jsonl`
- Flag clave no documentado: `--session-id <uuid>` (fuerza UUID específico al crear sesión)
