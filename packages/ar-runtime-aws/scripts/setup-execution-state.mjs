import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { AwsSetupError } from './setup-aws-cli.mjs';

export function canonicalSetupJson(value) {
  const normalize = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && Object.getPrototypeOf(item) === Object.prototype)
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key])])
      );
    throw new AwsSetupError('aws_setup_json_invalid');
  };
  return JSON.stringify(normalize(value));
}

export const setupDigest = (value) => createHash('sha256').update(value).digest('hex');

/** Resolve parent aliases once, then operate on that directory rather than following them again. */
async function canonicalPath(path) {
  const absolute = resolve(path);
  return join(await realpath(dirname(absolute)), basename(absolute));
}

export async function readSetupFile(
  path,
  { maxBytes = 4 * 1024 * 1024, privateFile = false } = {}
) {
  let handle;
  try {
    handle = await open(await canonicalPath(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maxBytes ||
      (privateFile && (Number(before.mode) & 0o077) !== 0)
    )
      throw new AwsSetupError('aws_setup_file_invalid');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      bytes.length !== Number(before.size)
    )
      throw new AwsSetupError('aws_setup_file_changed');
    return bytes;
  } catch (error) {
    if (error instanceof AwsSetupError) throw error;
    if (error.code === 'ENOENT') throw new AwsSetupError('aws_setup_file_missing');
    throw new AwsSetupError('aws_setup_file_invalid');
  } finally {
    await handle?.close();
  }
}

export async function readSetupJson(path, options) {
  try {
    return JSON.parse((await readSetupFile(path, options)).toString('utf8'));
  } catch (error) {
    if (error instanceof AwsSetupError) throw error;
    throw new AwsSetupError('aws_setup_json_invalid');
  }
}

/** State contains only pinned locations, digests and allow-listed receipts, never secret values. */
export async function writeSetupState(path, state, { newline = true } = {}) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const destination = await canonicalPath(path);
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0)
      throw new AwsSetupError('aws_setup_file_invalid');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${canonicalSetupJson(state)}${newline ? '\n' : ''}`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    const parent = await open(dirname(destination), constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Never unlink a stale lock automatically: competing reclaimers cannot safely perform a CAS with unlink. */
export async function lockSetupState(path) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const lockPath = `${await canonicalPath(path)}.lock`;
  const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(canonicalSetupJson(owner));
      await handle.close();
      return async () => {
        const current = await readSetupJson(lockPath, { privateFile: true });
        if (current.token !== owner.token) throw new AwsSetupError('aws_setup_lock_changed');
        await unlink(lockPath);
      };
    } catch (error) {
      await handle?.close();
      if (error.code !== 'EEXIST') throw error;
      const previous = await readSetupJson(lockPath, { privateFile: true });
      if (previous.host !== owner.host || !Number.isSafeInteger(previous.pid) || previous.pid < 1)
        throw new AwsSetupError('aws_setup_locked');
      try {
        process.kill(previous.pid, 0);
      } catch (probe) {
        if (probe.code === 'ESRCH') throw new AwsSetupError('aws_setup_stale_lock_requires_review');
      }
      throw new AwsSetupError('aws_setup_locked');
    }
  }
  throw new AwsSetupError('aws_setup_locked');
}
