#!/usr/bin/env node
'use strict';

/**
 * Crear o actualizar usuario en ClaudeClaw
 * Uso: node scripts/add-user.js <userId> <password> [displayName]
 *
 * Ejemplos:
 *   node scripts/add-user.js hijo   MiPass123  "Hijo"
 *   node scripts/add-user.js esposa OtraPass   "Esposa"
 *   node scripts/add-user.js hija   Pass456    "Hija"
 */

// Cargar variables de entorno desde .env si existe
const envPath = require('path').join(__dirname, '..', '..', '.env');
try { require('fs').readFileSync(envPath, 'utf8').split('\n').forEach(line => {
  const [k, ...v] = line.split('=');
  if (k && !k.startsWith('#') && !(k.trim() in process.env)) process.env[k.trim()] = v.join('=').trim();
}); } catch {}

const db = require('../lib/pgdb');

async function main() {
  const [,, userId, password, displayName] = process.argv;

  if (!userId || !password) {
    console.error('Uso: node scripts/add-user.js <userId> <password> [displayName]');
    process.exit(1);
  }

  try {
    await db.init();
    await db.createUser({ userId, password, displayName: displayName || userId });
    console.log(`✓ Usuario "${userId}" creado/actualizado correctamente.`);
    console.log(`  Display name: ${displayName || userId}`);
    console.log(`  Puede iniciar sesión en la PWA con usuario "${userId}" y el password indicado.`);
  } catch (err) {
    console.error('✗ Error:', err.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

main();
