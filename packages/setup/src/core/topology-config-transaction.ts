import { existsSync } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthrimConfigSchema, type AuthrimConfig } from './config.js';
import { saveLockFile, type AuthrimLock, type TopologyUpdateKind } from './lock.js';
import { calculateTopologyConfigChecksum, prepareTopologyUpdate } from './topology-update.js';

export type TopologyConfigTransactionPoint =
  | 'after_staged_config'
  | 'after_preparing_lock'
  | 'after_config_commit'
  | 'after_pending_lock';

interface TopologyConfigTransactionIdentity {
  kind: TopologyUpdateKind;
  targetProductVersion: string;
  subject?: string;
}

interface TopologyConfigTransactionInput extends TopologyConfigTransactionIdentity {
  lock: AuthrimLock;
  lockPath: string;
  configPath: string;
  config: AuthrimConfig;
  onPoint?: (point: TopologyConfigTransactionPoint) => void | Promise<void>;
}

export interface TopologyConfigTransactionResult {
  lock: AuthrimLock;
  config: AuthrimConfig;
  authorizationToken: string;
  resumed: boolean;
}

export function topologyPendingConfigPath(configPath: string): string {
  return `${configPath}.topology-pending`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), 'r').catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readConfig(path: string): Promise<AuthrimConfig> {
  return AuthrimConfigSchema.parse(JSON.parse(await readFile(path, 'utf-8')));
}

function assertTransactionIdentity(
  lock: AuthrimLock,
  identity: TopologyConfigTransactionIdentity
): void {
  const update = lock.topologyUpdate;
  if (!update) throw new Error('topology_update_authorization_required');
  if (update.kind !== identity.kind) {
    throw new Error(`topology_update_kind_mismatch:${update.kind}:${identity.kind}`);
  }
  if (update.targetProductVersion !== identity.targetProductVersion) {
    throw new Error('topology_update_product_version_changed');
  }
  if (update.subject !== identity.subject) {
    throw new Error('topology_update_subject_changed');
  }
}

export async function readEffectiveTopologyConfig(
  lock: AuthrimLock,
  configPath: string
): Promise<AuthrimConfig> {
  const current = await readConfig(configPath);
  const update = lock.topologyUpdate;
  if (!update || update.phase !== 'config_staged') return current;
  if (calculateTopologyConfigChecksum(current) === update.configChecksum) return current;

  const stagedPath = topologyPendingConfigPath(configPath);
  if (!existsSync(stagedPath)) throw new Error('topology_staged_config_missing');
  const staged = await readConfig(stagedPath);
  if (calculateTopologyConfigChecksum(staged) !== update.configChecksum) {
    throw new Error('topology_staged_config_checksum_mismatch');
  }
  return staged;
}

export async function commitTopologyConfigTransaction(
  input: TopologyConfigTransactionInput
): Promise<TopologyConfigTransactionResult> {
  if (input.lock.topologyUpdate) {
    throw new Error(`topology_update_pending:${input.lock.topologyUpdate.kind}`);
  }
  const stagedPath = topologyPendingConfigPath(input.configPath);
  const content = `${JSON.stringify(input.config, null, 2)}\n`;
  await writeDurableFile(stagedPath, content);
  await input.onPoint?.('after_staged_config');

  const preparing = prepareTopologyUpdate(input.lock, {
    kind: input.kind,
    phase: 'config_staged',
    targetProductVersion: input.targetProductVersion,
    config: input.config,
    subject: input.subject,
  });
  await saveLockFile(preparing.lock, input.lockPath);
  await input.onPoint?.('after_preparing_lock');

  await rename(stagedPath, input.configPath);
  await syncDirectory(input.configPath);
  await input.onPoint?.('after_config_commit');

  const pending = prepareTopologyUpdate(preparing.lock, {
    kind: input.kind,
    phase: 'pending_deploy',
    targetProductVersion: input.targetProductVersion,
    config: input.config,
    subject: input.subject,
  });
  await saveLockFile(pending.lock, input.lockPath);
  await input.onPoint?.('after_pending_lock');
  return {
    lock: pending.lock,
    config: input.config,
    authorizationToken: pending.authorizationToken,
    resumed: false,
  };
}

export async function recoverTopologyConfigTransaction(
  input: Omit<TopologyConfigTransactionInput, 'config'>
): Promise<TopologyConfigTransactionResult> {
  assertTransactionIdentity(input.lock, input);
  const update = input.lock.topologyUpdate!;
  if (update.phase !== 'config_staged') {
    throw new Error(`topology_config_transaction_not_staged:${update.phase}`);
  }

  const config = await readEffectiveTopologyConfig(input.lock, input.configPath);
  const current = await readConfig(input.configPath);
  const stagedPath = topologyPendingConfigPath(input.configPath);
  if (calculateTopologyConfigChecksum(current) !== update.configChecksum) {
    await rename(stagedPath, input.configPath);
    await syncDirectory(input.configPath);
    await input.onPoint?.('after_config_commit');
  } else {
    await rm(stagedPath, { force: true });
  }

  const pending = prepareTopologyUpdate(input.lock, {
    kind: input.kind,
    phase: 'pending_deploy',
    targetProductVersion: input.targetProductVersion,
    config,
    subject: input.subject,
  });
  await saveLockFile(pending.lock, input.lockPath);
  await input.onPoint?.('after_pending_lock');
  return {
    lock: pending.lock,
    config,
    authorizationToken: pending.authorizationToken,
    resumed: true,
  };
}
