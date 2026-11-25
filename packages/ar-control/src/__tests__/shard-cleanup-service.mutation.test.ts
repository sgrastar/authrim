import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ShardCleanupService, activeRegistryVerificationKeys } from '../shard-cleanup';
import type { ControlEnv } from '../types';
import {
  APPROVAL,
  NOW,
  QUARANTINE_REQUEST,
  VIEW,
  callArg,
  repository,
  service,
} from './support/shard-cleanup-fixtures';

describe('list and get', () => {
  it('forwards identifiers and the destructive flag', async () => {
    const repo = repository();
    repo.list.mockResolvedValue([VIEW]);
    repo.get.mockResolvedValue(VIEW);
    const { instance } = service(repo, { destructiveOperationsEnabled: false });
    await expect(instance.list('env-1')).resolves.toEqual([VIEW]);
    await expect(instance.get('env-1', 'shard-1')).resolves.toBe(VIEW);
    expect(repo.list).toHaveBeenCalledExactlyOnceWith('env-1', false);
    expect(repo.get).toHaveBeenCalledExactlyOnceWith('env-1', 'shard-1', false);
  });

  it('rejects unsafe identifiers before reading', () => {
    const repo = repository();
    const { instance } = service(repo);
    expect(() => instance.list('-bad')).toThrow(/^invalid_environment_id$/u);
    expect(() => instance.get('env-1', '')).toThrow(/^invalid_shard_id$/u);
    expect(() => instance.get('-env', 'shard-1')).toThrow(/^invalid_environment_id$/u);
    expect(repo.list).not.toHaveBeenCalled();
    expect(repo.get).not.toHaveBeenCalled();
  });
});

describe('quarantine', () => {
  it('starts a new quarantine with a deterministic operation id and reads it back', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(null);
    repo.get.mockResolvedValue(VIEW);
    const { instance } = service(repo);
    await expect(instance.quarantine('env-1', QUARANTINE_REQUEST)).resolves.toBe(VIEW);
    const call = repo.startQuarantine.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({ environmentId: 'env-1', request: QUARANTINE_REQUEST, now: NOW });
    expect(call.operationId).toMatch(/^quarantine_[0-9a-f]{32}$/u);
    expect(repo.findExistingOperation).toHaveBeenCalledExactlyOnceWith('env-1', 'idem-1');
    await instance.quarantine('env-1', QUARANTINE_REQUEST);
    expect(callArg(repo.startQuarantine, 1).operationId).toBe(call.operationId);
    await instance.quarantine('env-1', { ...QUARANTINE_REQUEST, idempotencyKey: 'idem-9' });
    expect(callArg(repo.startQuarantine, 2).operationId).not.toBe(call.operationId);
  });

  it('fails when the new quarantine cannot be read back', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(null);
    repo.get.mockResolvedValue(null);
    await expect(service(repo).instance.quarantine('env-1', QUARANTINE_REQUEST)).rejects.toThrow(
      /^control_shard_quarantine_reflection_failed$/u
    );
  });

  it('replays an identical request without starting another quarantine', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue({
      operation_kind: 'quarantine_shard',
      shard_id: 'shard-1',
      requested_by_id: 'admin-1',
    });
    repo.get.mockResolvedValue(VIEW);
    await expect(service(repo).instance.quarantine('env-1', QUARANTINE_REQUEST)).resolves.toBe(
      VIEW
    );
    expect(repo.startQuarantine).not.toHaveBeenCalled();
    expect(repo.get).toHaveBeenCalledExactlyOnceWith('env-1', 'shard-1', true);
  });

  it.each([
    [{ operation_kind: 'cleanup_shard', shard_id: 'shard-1', requested_by_id: 'admin-1' }],
    [{ operation_kind: 'quarantine_shard', shard_id: 'shard-2', requested_by_id: 'admin-1' }],
    [{ operation_kind: 'quarantine_shard', shard_id: 'shard-1', requested_by_id: 'admin-2' }],
  ])('rejects a conflicting replay %j', async (existing) => {
    const repo = repository();
    repo.get.mockResolvedValue(VIEW);
    repo.findExistingOperation.mockResolvedValue(existing);
    await expect(service(repo).instance.quarantine('env-1', QUARANTINE_REQUEST)).rejects.toThrow(
      /^control_shard_quarantine_idempotency_conflict$/u
    );
    expect(repo.startQuarantine).not.toHaveBeenCalled();
  });

  it('rejects a replay whose shard view disappeared', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue({
      operation_kind: 'quarantine_shard',
      shard_id: 'shard-1',
      requested_by_id: 'admin-1',
    });
    repo.get.mockResolvedValue(null);
    await expect(service(repo).instance.quarantine('env-1', QUARANTINE_REQUEST)).rejects.toThrow(
      /^control_shard_quarantine_idempotency_conflict$/u
    );
  });

  it.each([
    ['-env', QUARANTINE_REQUEST, 'invalid_environment_id'],
    ['env-1', { ...QUARANTINE_REQUEST, shardId: '' }, 'invalid_shard_id'],
    ['env-1', { ...QUARANTINE_REQUEST, idempotencyKey: '-k' }, 'invalid_idempotency_key'],
  ])('validates %s %j', async (environmentId, request, code) => {
    const repo = repository();
    await expect(service(repo).instance.quarantine(environmentId, request)).rejects.toThrow(
      new RegExp(`^${code}$`, 'u')
    );
    expect(repo.findExistingOperation).not.toHaveBeenCalled();
  });
});

describe('approveCleanup', () => {
  const existingRow = {
    operation_kind: 'cleanup_shard',
    shard_id: 'shard-1',
    requested_by_id: 'admin-1',
    quarantine_operation_id: 'quarantine-op',
    export_mode: 'manual_verified',
    export_evidence_id: 'evidence-1',
    delete_database: 1,
    operation_id: 'cleanup-op',
  };

  it('approves a fresh request with a deterministic cleanup operation id', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(null);
    repo.approveCleanup.mockResolvedValue('shard-1');
    repo.get.mockResolvedValue(VIEW);
    const { instance } = service(repo);
    await expect(instance.approveCleanup('env-1', APPROVAL)).resolves.toBe(VIEW);
    const call = repo.approveCleanup.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      environmentId: 'env-1',
      request: APPROVAL,
      destructiveOperationsEnabled: true,
      now: NOW,
    });
    expect(call.operationId).toMatch(/^cleanup_[0-9a-f]{32}$/u);
    expect(repo.get).toHaveBeenCalledExactlyOnceWith('env-1', 'shard-1', true);
  });

  it('passes the disabled destructive flag through', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(null);
    repo.approveCleanup.mockResolvedValue('shard-1');
    repo.get.mockResolvedValue(VIEW);
    await service(repo, { destructiveOperationsEnabled: false }).instance.approveCleanup(
      'env-1',
      APPROVAL
    );
    expect(callArg(repo.approveCleanup).destructiveOperationsEnabled).toBe(false);
  });

  it('fails when the approved cleanup cannot be read back', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(null);
    repo.approveCleanup.mockResolvedValue('shard-1');
    repo.get.mockResolvedValue(null);
    await expect(service(repo).instance.approveCleanup('env-1', APPROVAL)).rejects.toThrow(
      /^control_shard_cleanup_reflection_failed$/u
    );
  });

  it('replays an identical approval', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(existingRow);
    repo.get.mockResolvedValue(VIEW);
    await expect(service(repo).instance.approveCleanup('env-1', APPROVAL)).resolves.toBe(VIEW);
    expect(repo.approveCleanup).not.toHaveBeenCalled();
    expect(repo.get).toHaveBeenCalledExactlyOnceWith('env-1', 'shard-1', true);
  });

  it.each([
    ['kind', { operation_kind: 'quarantine_shard' }],
    ['missing shard', { shard_id: null }],
    ['requester', { requested_by_id: 'admin-2' }],
    ['quarantine', { quarantine_operation_id: 'other' }],
    ['export mode', { export_mode: 'skipped' }],
    ['evidence', { export_evidence_id: 'other' }],
    ['delete flag', { delete_database: 0 }],
  ])('rejects a replay that differs in %s', async (_name, patch) => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue({ ...existingRow, ...patch });
    repo.get.mockResolvedValue(VIEW);
    await expect(service(repo).instance.approveCleanup('env-1', APPROVAL)).rejects.toThrow(
      /^control_shard_cleanup_idempotency_conflict$/u
    );
    expect(repo.approveCleanup).not.toHaveBeenCalled();
  });

  it('rejects a replay whose view is missing or belongs to another cleanup', async () => {
    for (const view of [null, { ...VIEW, cleanupOperationId: 'other' }]) {
      const repo = repository();
      repo.findExistingOperation.mockResolvedValue(existingRow);
      repo.get.mockResolvedValue(view);
      await expect(service(repo).instance.approveCleanup('env-1', APPROVAL)).rejects.toThrow(
        /^control_shard_cleanup_idempotency_conflict$/u
      );
    }
  });

  it('requires database deletion and consistent export evidence', async () => {
    const repo = repository();
    const { instance } = service(repo);
    await expect(
      instance.approveCleanup('env-1', { ...APPROVAL, deleteDatabase: false })
    ).rejects.toThrow(/^control_shard_cleanup_delete_required$/u);
    await expect(
      instance.approveCleanup('env-1', { ...APPROVAL, exportEvidenceId: null })
    ).rejects.toThrow(/^control_shard_cleanup_export_evidence_invalid$/u);
    await expect(
      instance.approveCleanup('env-1', { ...APPROVAL, exportMode: 'skipped' })
    ).rejects.toThrow(/^control_shard_cleanup_export_evidence_invalid$/u);
    await expect(
      instance.approveCleanup('env-1', { ...APPROVAL, exportEvidenceId: '-bad' })
    ).rejects.toThrow(/^invalid_export_evidence_id$/u);
    expect(repo.findExistingOperation).not.toHaveBeenCalled();
  });

  it('accepts a skipped export without evidence', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(null);
    repo.approveCleanup.mockResolvedValue('shard-1');
    repo.get.mockResolvedValue(VIEW);
    await expect(
      service(repo).instance.approveCleanup('env-1', {
        ...APPROVAL,
        exportMode: 'skipped',
        exportEvidenceId: null,
      })
    ).resolves.toBe(VIEW);
  });

  it.each([
    ['-env', APPROVAL, 'invalid_environment_id'],
    ['env-1', { ...APPROVAL, quarantineOperationId: '' }, 'invalid_quarantine_operation_id'],
    ['env-1', { ...APPROVAL, idempotencyKey: '-k' }, 'invalid_idempotency_key'],
  ])('validates %s', async (environmentId, request, code) => {
    await expect(
      service(repository()).instance.approveCleanup(environmentId, request as never)
    ).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });
});

describe('retry operations', () => {
  const retryCleanup = {
    cleanupOperationId: 'cleanup-op',
    requestedById: 'admin-1',
    reasonCode: 'operator_retry_cleanup',
    idempotencyKey: 'idem-3',
  } as const;
  const retryQuarantine = {
    quarantineOperationId: 'quarantine-op',
    requestedById: 'admin-1',
    reasonCode: 'operator_retry_quarantine',
    idempotencyKey: 'idem-4',
  } as const;

  it('retries cleanup only when destructive operations are enabled', async () => {
    const repo = repository();
    repo.retryCleanup.mockResolvedValue('shard-1');
    repo.get.mockResolvedValue(VIEW);
    await expect(service(repo).instance.retryCleanup('env-1', retryCleanup)).resolves.toBe(VIEW);
    expect(repo.retryCleanup).toHaveBeenCalledExactlyOnceWith({
      environmentId: 'env-1',
      request: retryCleanup,
      now: NOW,
    });
    const disabled = repository();
    await expect(
      service(disabled, { destructiveOperationsEnabled: false }).instance.retryCleanup(
        'env-1',
        retryCleanup
      )
    ).rejects.toThrow(/^control_destructive_operations_disabled$/u);
    expect(disabled.retryCleanup).not.toHaveBeenCalled();
    repo.get.mockResolvedValue(null);
    await expect(service(repo).instance.retryCleanup('env-1', retryCleanup)).rejects.toThrow(
      /^control_shard_cleanup_reflection_failed$/u
    );
    await expect(service(repo).instance.retryCleanup('-env', retryCleanup)).rejects.toThrow(
      /^invalid_environment_id$/u
    );
  });

  it('retries a quarantine and validates ids first', async () => {
    const repo = repository();
    repo.retryQuarantine.mockResolvedValue('shard-1');
    repo.get.mockResolvedValue(VIEW);
    const { instance } = service(repo, { destructiveOperationsEnabled: false });
    await expect(instance.retryQuarantine('env-1', retryQuarantine)).resolves.toBe(VIEW);
    expect(repo.retryQuarantine).toHaveBeenCalledExactlyOnceWith({
      environmentId: 'env-1',
      request: retryQuarantine,
      now: NOW,
    });
    repo.get.mockResolvedValue(null);
    await expect(instance.retryQuarantine('env-1', retryQuarantine)).rejects.toThrow(
      /^control_shard_quarantine_reflection_failed$/u
    );
    await expect(
      instance.retryQuarantine('env-1', { ...retryQuarantine, quarantineOperationId: '' })
    ).rejects.toThrow(/^invalid_quarantine_operation_id$/u);
    await expect(
      instance.retryQuarantine('env-1', { ...retryQuarantine, idempotencyKey: '' })
    ).rejects.toThrow(/^invalid_idempotency_key$/u);
    await expect(instance.retryQuarantine('-env', retryQuarantine)).rejects.toThrow(
      /^invalid_environment_id$/u
    );
  });
});

describe('runtime registry verification keys', () => {
  const jwk = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      kty: 'OKP',
      crv: 'Ed25519',
      x: 'abc',
      kid: 'key-1',
      d: 'secret',
      ...overrides,
    });
  const keys = (env: Partial<ControlEnv>) => activeRegistryVerificationKeys(env as ControlEnv);

  it('strips private members and pins verification usage', () => {
    expect(keys({ RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: jwk({ p: 'p', q: 'q', k: 'k' }) })).toEqual([
      {
        keyId: 'key-1',
        publicJwk: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: 'abc',
          kid: 'key-1',
          alg: 'EdDSA',
          use: 'sig',
          key_ops: ['verify'],
        },
      },
    ]);
  });

  it('strips every private member of the key material', () => {
    const [key] = keys({
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: jwk({
        d: 'd',
        p: 'p',
        q: 'q',
        dp: 'dp',
        dq: 'dq',
        qi: 'qi',
        oth: 'oth',
        k: 'k',
      }),
    });
    expect(Object.keys(key?.publicJwk ?? {}).sort()).toEqual(
      ['alg', 'crv', 'key_ops', 'kid', 'kty', 'use', 'x'].sort()
    );
  });

  it('reads both slots in order and skips an empty one', () => {
    const both = keys({
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: jwk({ kid: 'a' }),
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B: jwk({ kid: 'b' }),
    });
    expect(both.map((key) => key.keyId)).toEqual(['a', 'b']);
    expect(
      keys({ RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B: jwk({ kid: 'b' }) }).map((key) => key.keyId)
    ).toEqual(['b']);
  });

  it('requires at least one key', () => {
    expect(() => keys({})).toThrow(/^control_runtime_registry_verification_keys_invalid$/u);
  });

  it.each([
    ['not json'],
    ['null'],
    ['[]'],
    ['"x"'],
    [jwk({ kty: 'RSA' })],
    [jwk({ crv: 'P-256' })],
    [jwk({ x: 5 })],
    [jwk({ kid: 5 })],
    [jwk({ kid: '-bad' })],
    [jwk({ kid: undefined })],
  ])('rejects the malformed key %s', (serialized) => {
    expect(() => keys({ RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: serialized })).toThrow(
      /^control_runtime_registry_signing_key_invalid$/u
    );
  });

  it('builds the service environment from fromEnv', () => {
    const repo = repository();
    const base = {
      RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A: jwk(),
      TENANT_RUNTIME_REGISTRY: { marker: 'registry' },
    };
    const build = (env: Record<string, unknown>) =>
      ShardCleanupService.fromEnv(
        env as never,
        repo as never,
        {} as never,
        {} as never,
        () => NOW
      ) as unknown as {
        dependencies: Record<string, unknown>;
      };
    const enabled = build({
      ...base,
      AUTHRIM_DEPLOYMENT_TARGET: ' blue ',
      CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED: 'true',
    });
    expect(enabled.dependencies).toMatchObject({
      repository: repo,
      registry: { marker: 'registry' },
      deploymentTarget: 'blue',
      destructiveOperationsEnabled: true,
    });
    expect((enabled.dependencies.now as () => number)()).toBe(NOW);
    const defaults = build({
      ...base,
      AUTHRIM_DEPLOYMENT_TARGET: '   ',
      CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED: 'TRUE',
    });
    expect(defaults.dependencies).toMatchObject({
      deploymentTarget: 'default',
      destructiveOperationsEnabled: false,
    });
    expect(build(base).dependencies.deploymentTarget).toBe('default');
  });
});

describe('operation id derivation', () => {
  const digest = (parts: string[], prefix: string) =>
    `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;

  it('derives the quarantine operation id from environment, kind, shard and key', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(null);
    repo.get.mockResolvedValue(VIEW);
    const { instance } = service(repo);
    await instance.quarantine('env-1', QUARANTINE_REQUEST);
    expect(callArg(repo.startQuarantine).operationId).toBe(
      digest(['env-1', 'quarantine_shard', 'shard-1', 'idem-1'], 'quarantine')
    );
    await instance.quarantine('env-1', {
      ...QUARANTINE_REQUEST,
      shardId: 'shard-a',
      idempotencyKey: '1b',
    });
    await instance.quarantine('env-1', {
      ...QUARANTINE_REQUEST,
      shardId: 'shard-a1',
      idempotencyKey: 'b',
    });
    expect(callArg(repo.startQuarantine, 1).operationId).not.toBe(
      callArg(repo.startQuarantine, 2).operationId
    );
  });

  it('derives the cleanup operation id from environment, kind, quarantine and key', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(null);
    repo.approveCleanup.mockResolvedValue('shard-1');
    repo.get.mockResolvedValue(VIEW);
    await service(repo).instance.approveCleanup('env-1', APPROVAL);
    expect(callArg(repo.approveCleanup).operationId).toBe(
      digest(['env-1', 'cleanup_shard', 'quarantine-op', 'idem-2'], 'cleanup')
    );
  });

  it('pads single digit bytes so ids keep their full entropy', async () => {
    const repo = repository();
    repo.findExistingOperation.mockResolvedValue(null);
    repo.get.mockResolvedValue(VIEW);
    const { instance } = service(repo);
    for (let index = 0; index < 40; index += 1) {
      await instance.quarantine('env-1', {
        ...QUARANTINE_REQUEST,
        idempotencyKey: `idem-${index}`,
      });
      expect(callArg(repo.startQuarantine, index).operationId).toBe(
        digest(['env-1', 'quarantine_shard', 'shard-1', `idem-${index}`], 'quarantine')
      );
    }
  });
});
