'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');

const WORK_DIR = process.env.WORK_DIR || path.join(os.homedir(), '0Proyectos', 'MyClaw');
// Path real de WORK_DIR para comparaciones de symlinks (en macOS /var/folders → /private/var/folders)
const _WORK_DIR_REAL = fs.existsSync(WORK_DIR) ? fs.realpathSync(WORK_DIR) : WORK_DIR;

// Tokens de compartir: token → { filePath, expiresAt }
const shareTokens = new Map();
const SHARE_TTL_MS = 60 * 60 * 1000; // 1 hora

// Prevención de path traversal — rechaza cualquier path que escape WORK_DIR
function safePath(userPath) {
  if (!userPath) throw Object.assign(new Error('path_required'), { code: 'path_required' });
  // path.resolve maneja todos los casos: ../../, /abs, symlinks conceptuales
  const resolved = path.resolve(WORK_DIR, userPath);
  if (!resolved.startsWith(WORK_DIR + path.sep) && resolved !== WORK_DIR) {
    throw Object.assign(new Error('path_traversal'), { code: 'path_traversal' });
  }
  // Validar que el path real (siguiendo symlinks) también esté dentro de WORK_DIR.
  // Usamos _WORK_DIR_REAL para evitar falsos positivos en macOS (/var/folders → /private/var/folders).
  if (fs.existsSync(resolved)) {
    const realResolved = fs.realpathSync(resolved);
    if (!realResolved.startsWith(_WORK_DIR_REAL + path.sep) && realResolved !== _WORK_DIR_REAL) {
      throw Object.assign(new Error('path_traversal'), { code: 'path_traversal' });
    }
  }
  return resolved;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fileType(ext) {
  const e = ext.toLowerCase();
  if (['.jpg','.jpeg','.png','.gif','.webp','.svg'].includes(e)) return 'image';
  if (['.pdf'].includes(e)) return 'pdf';
  if (['.mp3','.ogg','.wav','.m4a','.oga'].includes(e)) return 'audio';
  if (['.mp4','.mov','.webm'].includes(e)) return 'video';
  if (['.js','.ts','.py','.sh','.json','.yml','.yaml','.md','.txt','.csv','.html','.css'].includes(e)) return 'text';
  return 'binary';
}

// Listar directorio (subdir relativo a WORK_DIR)
function listDir(subdir) {
  const dirPath = subdir ? safePath(subdir) : WORK_DIR;
  if (!fs.existsSync(dirPath)) return [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .map(entry => {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(WORK_DIR, fullPath);
      try {
        const stat = fs.statSync(fullPath);
        return {
          name: entry.name,
          path: relativePath,
          isDir: entry.isDirectory(),
          size: entry.isDirectory() ? null : stat.size,
          sizeHuman: entry.isDirectory() ? null : humanSize(stat.size),
          modified: stat.mtimeMs,
          type: entry.isDirectory() ? 'dir' : fileType(path.extname(entry.name)),
          ext: entry.isDirectory() ? null : path.extname(entry.name).toLowerCase(),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      // Carpetas primero, luego por fecha desc
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return b.modified - a.modified;
    });
}

// Leer contenido de archivo (text/code/md)
function readFile(relativePath) {
  const fullPath = safePath(relativePath);
  const stat = fs.statSync(fullPath);
  if (stat.size > 2 * 1024 * 1024) throw new Error('file_too_large'); // 2MB max para preview texto
  return fs.readFileSync(fullPath, 'utf8');
}

// Mover archivo
function moveFile(fromRel, toRel) {
  const from = safePath(fromRel);
  const to = safePath(toRel);
  const toDir = path.dirname(to);
  if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
  fs.renameSync(from, to);
  return path.relative(WORK_DIR, to);
}

// Renombrar archivo
function renameFile(fromRel, newName) {
  const from = safePath(fromRel);
  const to = path.join(path.dirname(from), path.basename(newName));
  // Validar que el nuevo nombre también esté dentro de WORK_DIR
  const toResolved = path.resolve(to);
  if (!toResolved.startsWith(WORK_DIR)) throw Object.assign(new Error('path_traversal'), { code: 'path_traversal' });
  fs.renameSync(from, to);
  return path.relative(WORK_DIR, to);
}

// Eliminar archivo o directorio (nunca permite borrar WORK_DIR raíz)
function deleteFile(relativePath) {
  const fullPath = safePath(relativePath);
  // Nunca permitir borrar la raíz del workspace
  if (fullPath === WORK_DIR) {
    throw Object.assign(new Error('cannot_delete_root'), { code: 'path_traversal' });
  }
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    fs.rmSync(fullPath, { recursive: true });
  } else {
    fs.unlinkSync(fullPath);
  }
}

// Generar token de compartir (1 hora)
function createShareToken(relativePath) {
  // Verificar que el path existe y es seguro
  const fullPath = safePath(relativePath);
  if (!fs.existsSync(fullPath)) throw new Error('file_not_found');

  // Limpiar tokens expirados
  const now = Date.now();
  for (const [k, v] of shareTokens) {
    if (now > v.expiresAt) shareTokens.delete(k);
  }

  const token = crypto.randomBytes(16).toString('hex');
  shareTokens.set(token, { filePath: fullPath, expiresAt: now + SHARE_TTL_MS });
  return token;
}

// Resolver token de compartir → path absoluto (o null si inválido/expirado)
function resolveShareToken(token) {
  const entry = shareTokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    shareTokens.delete(token);
    return null;
  }
  return entry.filePath;
}

// Mime type básico para serving
function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.txt': 'text/plain',
    '.md': 'text/plain',
    '.csv': 'text/csv',
    '.sh': 'text/plain',
    '.py': 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

module.exports = { safePath, listDir, readFile, moveFile, renameFile, deleteFile, createShareToken, resolveShareToken, mimeType, WORK_DIR };
