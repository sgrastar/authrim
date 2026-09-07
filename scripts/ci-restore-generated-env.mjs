#!/usr/bin/env node
// Restore generated Authrim deployment inputs from GitHub Actions secrets.
//
// Required env vars:
//   AUTHRIM_ENV_NAME          Environment name, e.g. test
//   AUTHRIM_ENV_CONFIG        Contents of .authrim/{env}/config.json
//   AUTHRIM_ENV_LOCK_GZIP_B64 base64(gzip(.authrim/{env}/lock.json))
//   AUTHRIM_ENV_KEYS_TAR_B64  base64(tar.gz) of the contents of .authrim-keys/{env}
//
// Create the key archive with:
//   tar -C .authrim-keys/test -czf - . | base64 | pbcopy

import { Buffer } from 'node:buffer';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { decodeGzipBase64Secret } from './lib/ci-secret-codec.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`❌ ${name} is required`);
    process.exit(1);
  }
  return value;
}

function validateEnvName(env) {
  if (!/^[a-z][a-z0-9-]*$/.test(env)) {
    console.error(`❌ Invalid AUTHRIM_ENV_NAME: ${env}`);
    process.exit(1);
  }
}

function parseJsonSecret(name, value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    console.error(
      `❌ ${name} is not valid JSON: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }
}

async function writeJsonSecret(path, value) {
  const parsed = parseJsonSecret(path, value);
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
}

async function chmodRecursive(path) {
  if (!existsSync(path)) {
    return;
  }
  const { readdir, stat } = await import('node:fs/promises');
  const info = await stat(path);
  if (!info.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const entry of await readdir(path)) {
    await chmodRecursive(join(path, entry));
  }
}

const env = requiredEnv('AUTHRIM_ENV_NAME');
validateEnvName(env);

const configSecret = requiredEnv('AUTHRIM_ENV_CONFIG');
const compressedLockSecret = process.env.AUTHRIM_ENV_LOCK_GZIP_B64?.trim();
const legacyLockSecret = process.env.AUTHRIM_ENV_LOCK?.trim();
if (!compressedLockSecret && !legacyLockSecret) {
  console.error('❌ AUTHRIM_ENV_LOCK_GZIP_B64 is required');
  process.exit(1);
}
let lockSecret = legacyLockSecret;
if (compressedLockSecret) {
  try {
    lockSecret = decodeGzipBase64Secret('AUTHRIM_ENV_LOCK_GZIP_B64', compressedLockSecret);
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
const keysArchiveSecret = requiredEnv('AUTHRIM_ENV_KEYS_TAR_B64').replace(/\s+/g, '');

const envDir = join(rootDir, '.authrim', env);
const keysDir = join(rootDir, '.authrim-keys', env);
const archivePath = join(envDir, 'keys.tar.gz');

await mkdir(envDir, { recursive: true });
await mkdir(keysDir, { recursive: true });

await writeJsonSecret(join(envDir, 'config.json'), configSecret);
await writeJsonSecret(join(envDir, 'lock.json'), lockSecret);

await rm(keysDir, { recursive: true, force: true });
await mkdir(keysDir, { recursive: true, mode: 0o700 });
await writeFile(archivePath, Buffer.from(keysArchiveSecret, 'base64'));
await tar.x({
  file: archivePath,
  cwd: keysDir,
  strict: true,
});
await rm(archivePath, { force: true });
await chmodRecursive(keysDir);

const config = parseJsonSecret(
  'AUTHRIM_ENV_CONFIG',
  await readFile(join(envDir, 'config.json'), 'utf-8')
);

console.log(`✅ Restored generated environment: ${env}`);
console.log(`   config: .authrim/${env}/config.json`);
console.log(`   lock:   .authrim/${env}/lock.json`);
console.log(`   keys:   .authrim-keys/${env}/`);
if (config?.urls?.api?.custom) {
  console.log(`   api:    ${config.urls.api.custom}`);
}
