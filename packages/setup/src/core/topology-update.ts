import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthrimConfig } from './config.js';
import type { AuthrimLock, TopologyUpdateKind, TopologyUpdateState } from './lock.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function calculateTopologyConfigChecksum(config: AuthrimConfig): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonicalize(entry)])
      );
    }
    return value;
  };
  return sha256(JSON.stringify(canonicalize(config)));
}

function tokenMatches(expectedHash: string, token: string): boolean {
  const actual = Buffer.from(sha256(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function topologyUpdateResumeInstruction(update: TopologyUpdateState, env: string): string {
  const prefix = 'npx @authrim/setup';
  const quotedEnv = quoteShellArgument(env);
  switch (update.kind) {
    case 'tenant_d1_pool':
      return `${prefix} tenant-db-pool-expand --env ${quotedEnv}`;
    case 'tenant_database': {
      const separator = update.subject?.lastIndexOf(':') ?? -1;
      const tenantId = separator > 0 ? update.subject?.slice(0, separator) : undefined;
      const generation = separator > 0 ? update.subject?.slice(separator + 1) : undefined;
      if (!tenantId || !generation || !/^\d+$/u.test(generation)) {
        return `${prefix} tenant-db --env ${quotedEnv} --tenant-id <recorded-tenant-id> --generation <recorded-generation>`;
      }
      const quotedTenantId = quoteShellArgument(tenantId);
      return `${prefix} tenant-db --env ${quotedEnv} --tenant-id ${quotedTenantId} --generation ${generation}`;
    }
    case 'r2':
      return `${prefix} r2-provision --env ${quotedEnv}`;
    case 'external_database':
      return `${prefix} external-db-register --env ${quotedEnv}`;
  }
}

export function prepareTopologyUpdate(
  lock: AuthrimLock,
  input: {
    kind: TopologyUpdateKind;
    phase?: 'config_staged' | 'preparing' | 'pending_deploy';
    targetProductVersion: string;
    config: AuthrimConfig;
    subject?: string;
  }
): { lock: AuthrimLock; authorizationToken: string; resumed: boolean } {
  const configChecksum = calculateTopologyConfigChecksum(input.config);
  const requestedPhase = input.phase ?? 'pending_deploy';
  const existing = lock.topologyUpdate;
  if (existing) {
    if (existing.kind !== input.kind) {
      throw new Error(`topology_update_pending:${existing.kind}`);
    }
    if (existing.targetProductVersion !== input.targetProductVersion) {
      throw new Error('topology_update_product_version_changed');
    }
    if (existing.configChecksum !== configChecksum) {
      throw new Error('topology_update_config_changed');
    }
    if (existing.subject !== input.subject) {
      throw new Error('topology_update_subject_changed');
    }
    if (existing.phase === 'pending_deploy' && requestedPhase !== 'pending_deploy') {
      throw new Error('topology_update_phase_regression');
    }
  }

  const authorizationToken = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  return {
    lock: {
      ...lock,
      topologyUpdate: {
        kind: input.kind,
        phase: requestedPhase,
        targetProductVersion: input.targetProductVersion,
        ...(input.subject ? { subject: input.subject } : {}),
        configChecksum,
        authorizationTokenHash: sha256(authorizationToken),
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
      },
      updatedAt: now,
    },
    authorizationToken,
    resumed: Boolean(existing),
  };
}

export function assertPendingTopologyUpdate(
  lock: AuthrimLock,
  input: {
    targetProductVersion: string;
    config: AuthrimConfig;
    kind?: TopologyUpdateKind;
    phase?: 'config_staged' | 'preparing' | 'pending_deploy';
    subject?: string;
    authorizationToken?: string;
  }
): void {
  const pending = lock.topologyUpdate;
  if (!pending) throw new Error('topology_update_authorization_required');
  if (input.kind && pending.kind !== input.kind) {
    throw new Error(`topology_update_kind_mismatch:${pending.kind}:${input.kind}`);
  }
  if (input.phase && pending.phase !== input.phase) {
    throw new Error(`topology_update_phase_mismatch:${pending.phase}:${input.phase}`);
  }
  if (input.subject !== undefined && pending.subject !== input.subject) {
    throw new Error('topology_update_subject_changed');
  }
  if (pending.targetProductVersion !== input.targetProductVersion) {
    throw new Error('topology_update_product_version_changed');
  }
  if (pending.configChecksum !== calculateTopologyConfigChecksum(input.config)) {
    throw new Error('topology_update_config_changed');
  }
  if (
    input.authorizationToken !== undefined &&
    !tokenMatches(pending.authorizationTokenHash, input.authorizationToken)
  ) {
    throw new Error('topology_update_token_invalid');
  }
}

export function completeTopologyUpdate(
  lock: AuthrimLock,
  input: { targetProductVersion: string; config: AuthrimConfig }
): AuthrimLock {
  assertPendingTopologyUpdate(lock, { ...input, phase: 'pending_deploy' });
  const { topologyUpdate: _completed, ...rest } = lock;
  return { ...rest, updatedAt: new Date().toISOString() };
}
