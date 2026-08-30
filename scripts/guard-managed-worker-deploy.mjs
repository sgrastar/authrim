#!/usr/bin/env node

import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_TICKET_LIFETIME_MS = 10 * 60_000;

function fail(reason) {
  throw new Error(
    `Authrim blocked an unmanaged Worker build (${reason}). ` +
      'Use the setup-managed deployment command so Control D1 bindings are refreshed and verified.'
  );
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function equalDigest(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

async function main() {
  const wranglerCommand = process.env.WRANGLER_COMMAND;
  if (wranglerCommand === 'dev' || wranglerCommand === 'types') {
    return;
  }
  if (wranglerCommand !== 'deploy' && wranglerCommand !== 'versions upload') {
    fail('Wrangler command is not an allowed managed deployment command');
  }

  const ticketPath = process.env.AUTHRIM_MANAGED_DEPLOY_TICKET;
  const nonce = process.env.AUTHRIM_MANAGED_DEPLOY_NONCE;
  const component = process.env.AUTHRIM_MANAGED_DEPLOY_COMPONENT;
  const environment = process.env.AUTHRIM_MANAGED_DEPLOY_ENVIRONMENT;
  const workerName = process.env.AUTHRIM_MANAGED_DEPLOY_WORKER_NAME;
  const expectedWranglerCommand = process.env.AUTHRIM_MANAGED_DEPLOY_WRANGLER_COMMAND;
  if (
    !ticketPath ||
    !nonce ||
    !component ||
    !environment ||
    !workerName ||
    !expectedWranglerCommand
  ) {
    fail('managed deployment ticket is missing');
  }

  const ticketStat = await lstat(ticketPath).catch(() => undefined);
  if (!ticketStat?.isFile() || (ticketStat.mode & 0o077) !== 0) {
    fail('managed deployment ticket is invalid');
  }

  let ticket;
  try {
    ticket = JSON.parse(await readFile(ticketPath, 'utf8'));
  } catch {
    fail('managed deployment ticket is unreadable');
  }

  if (
    ticket?.schemaVersion !== 2 ||
    ticket.wranglerCommand !== wranglerCommand ||
    expectedWranglerCommand !== wranglerCommand ||
    ticket.component !== component ||
    ticket.environment !== environment ||
    ticket.workerName !== workerName ||
    basename(process.cwd()) !== component
  ) {
    fail('managed deployment ticket scope does not match');
  }

  if (typeof ticket.configPath !== 'string' || typeof ticket.configDigest !== 'string') {
    fail('managed deployment config scope does not match');
  }
  const workingDirectory = await realpath(resolve(process.cwd()));
  const canonicalConfigPath = await realpath(ticket.configPath).catch(() => undefined);
  if (!canonicalConfigPath || dirname(canonicalConfigPath) !== workingDirectory) {
    fail('managed deployment config scope does not match');
  }
  const configStat = await lstat(canonicalConfigPath).catch(() => undefined);
  if (!configStat?.isFile()) {
    fail('managed deployment config is invalid');
  }
  const configContent = await readFile(canonicalConfigPath, 'utf8');
  if (!equalDigest(ticket.configDigest, digest(configContent).toString('base64url'))) {
    fail('managed deployment config changed after authorization');
  }

  const now = Date.now();
  if (
    !Number.isSafeInteger(ticket.expiresAt) ||
    ticket.expiresAt < now ||
    ticket.expiresAt > now + MAX_TICKET_LIFETIME_MS
  ) {
    fail('managed deployment ticket has expired');
  }
  if (
    typeof ticket.nonceDigest !== 'string' ||
    !equalDigest(ticket.nonceDigest, digest(nonce).toString('base64url'))
  ) {
    fail('managed deployment ticket authentication failed');
  }

  const consumedPath = join(dirname(ticketPath), 'consumed');
  let consumed;
  try {
    consumed = await open(consumedPath, 'wx', 0o600);
    await consumed.writeFile(String(now), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      fail('managed deployment ticket was already used');
    }
    throw error;
  } finally {
    await consumed?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
