import { describe, expect, it, vi } from 'vitest';
import { ControlService } from '../service';
import type { ControlRepository } from '../repository';
import type { ControlEnv } from '../types';

const NOW = 1_800_000_123;
const POLICY = { tenantId: 'tenant-1', state: 'active' };

function build() {
  const repository = {
    registerTenantPlacementPolicy: vi.fn().mockResolvedValue(POLICY),
    activateTenantPlacementPolicy: vi.fn().mockResolvedValue(POLICY),
    getTenantPlacementPolicy: vi.fn().mockResolvedValue(POLICY),
  };
  const service = new ControlService({
    repository: repository as unknown as ControlRepository,
    env: {} as ControlEnv,
    now: () => NOW,
  });
  return { repository, service };
}

const REGISTRATION = {
  tenantId: 'tenant-1',
  isolationPolicy: 'tenant_exclusive',
  sourceOperationId: 'op-1',
  idempotencyKey: 'idem-1',
};

const target = (role: string, shard: string, binding: string, generation = 1) => ({
  dataRole: role,
  shardId: shard,
  bindingRef: binding,
  generation,
});
const TARGETS = [
  target('tenant_core/default', 'shard-a', 'DB_A'),
  target('tenant_core/users', 'shard-b', 'DB_B', 2),
  target('tenant_pii', 'shard-c', 'DB_C', 3),
];
const route = (overrides: Record<string, unknown> = {}) => ({
  runtimeGeneration: 4,
  registryPublicationGeneration: 5,
  tenantLifecycleState: 'active',
  routeStatus: 'active',
  targets: TARGETS,
  ...overrides,
});
const ACTIVATION = {
  tenantId: 'tenant-1',
  sourceOperationId: 'op-1',
  idempotencyKey: 'idem-1',
  runtimeRoute: route(),
};

describe('registerTenantPlacementPolicy', () => {
  it('registers a validated request for the caller environment at the current time', async () => {
    const { repository, service } = build();
    await expect(service.registerTenantPlacementPolicy(REGISTRATION, 'env-1')).resolves.toBe(
      POLICY
    );
    expect(repository.registerTenantPlacementPolicy).toHaveBeenCalledExactlyOnceWith(
      { ...REGISTRATION, environmentId: 'env-1' },
      NOW
    );
  });

  it('accepts the shared pool policy', async () => {
    const { repository, service } = build();
    await service.registerTenantPlacementPolicy(
      { ...REGISTRATION, isolationPolicy: 'shared_pool' },
      'env-1'
    );
    expect(repository.registerTenantPlacementPolicy.mock.calls[0]?.[0]).toMatchObject({
      isolationPolicy: 'shared_pool',
    });
  });

  it.each([
    [null],
    [[]],
    ['x'],
    [{ ...REGISTRATION, extra: 1 }],
    [{ tenantId: 'tenant-1' }],
    [{ ...REGISTRATION, isolationPolicy: 'dedicated' }],
  ])('rejects %j as invalid_tenant_placement_policy', async (input) => {
    const { repository, service } = build();
    await expect(service.registerTenantPlacementPolicy(input, 'env-1')).rejects.toThrow(
      /^invalid_tenant_placement_policy$/u
    );
    expect(repository.registerTenantPlacementPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ['tenantId', 'invalid_tenant_id'],
    ['sourceOperationId', 'invalid_source_operation_id'],
    ['idempotencyKey', 'invalid_idempotency_key'],
  ])('rejects an unsafe %s', async (field, code) => {
    const { repository, service } = build();
    for (const bad of ['', '-x', 'a b', 5, 'x'.repeat(129)]) {
      await expect(
        service.registerTenantPlacementPolicy({ ...REGISTRATION, [field]: bad }, 'env-1')
      ).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
    }
    expect(repository.registerTenantPlacementPolicy).not.toHaveBeenCalled();
  });

  it('accepts a 128 character identifier and rejects an unsafe environment', async () => {
    const { repository, service } = build();
    await service.registerTenantPlacementPolicy(
      { ...REGISTRATION, tenantId: `a${'b'.repeat(127)}` },
      'env-1'
    );
    expect(repository.registerTenantPlacementPolicy).toHaveBeenCalledTimes(1);
    await expect(service.registerTenantPlacementPolicy(REGISTRATION, '-env')).rejects.toThrow(
      /^invalid_environment_id$/u
    );
  });

  it('refuses a repository result that carries secret material', async () => {
    const { repository, service } = build();
    repository.registerTenantPlacementPolicy.mockResolvedValue({ private_key: 'x' });
    await expect(service.registerTenantPlacementPolicy(REGISTRATION, 'env-1')).rejects.toThrow(
      /control_plane_sensitive_key_forbidden/u
    );
  });
});

describe('activateTenantPlacementPolicy', () => {
  it('activates with a normalized runtime route', async () => {
    const { repository, service } = build();
    await expect(service.activateTenantPlacementPolicy(ACTIVATION, 'env-1')).resolves.toBe(POLICY);
    expect(repository.activateTenantPlacementPolicy).toHaveBeenCalledExactlyOnceWith(
      { ...ACTIVATION, environmentId: 'env-1' },
      NOW
    );
  });

  it('copies only the declared fields of each route target', async () => {
    const { repository, service } = build();
    await service.activateTenantPlacementPolicy(ACTIVATION, 'env-1');
    const request = repository.activateTenantPlacementPolicy.mock.calls[0]?.[0] as {
      runtimeRoute: { targets: object[] };
    };
    expect(request.runtimeRoute.targets).toEqual(TARGETS);
    expect(request.runtimeRoute.targets[0]).not.toBe(TARGETS[0]);
  });

  it('accepts up to 4096 targets and refuses 4097', async () => {
    const { service } = build();
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        target('tenant_pii', `shard-${index}`, `DB_${index}`)
      );
    await expect(
      service.activateTenantPlacementPolicy(
        { ...ACTIVATION, runtimeRoute: route({ targets: many(4096) }) },
        'env-1'
      )
    ).resolves.toBe(POLICY);
    await expect(
      service.activateTenantPlacementPolicy(
        { ...ACTIVATION, runtimeRoute: route({ targets: many(4097) }) },
        'env-1'
      )
    ).rejects.toThrow(/^invalid_tenant_placement_policy_activation$/u);
  });

  it('accepts exactly three targets and refuses two', async () => {
    const { service } = build();
    await expect(
      service.activateTenantPlacementPolicy(
        { ...ACTIVATION, runtimeRoute: route({ targets: TARGETS.slice(0, 2) }) },
        'env-1'
      )
    ).rejects.toThrow(/^invalid_tenant_placement_policy_activation$/u);
  });

  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ['null input', null],
    ['array input', []],
    ['extra key', { ...ACTIVATION, extra: 1 }],
    ['missing key', { tenantId: 'tenant-1', sourceOperationId: 'op-1', idempotencyKey: 'k' }],
    ['null route', { ...ACTIVATION, runtimeRoute: null }],
    ['array route', { ...ACTIVATION, runtimeRoute: [] }],
    ['route extra key', { ...ACTIVATION, runtimeRoute: { ...route(), extra: 1 } }],
    ['route missing key', { ...ACTIVATION, runtimeRoute: { runtimeGeneration: 1 } }],
    ['generation 0', { ...ACTIVATION, runtimeRoute: route({ runtimeGeneration: 0 }) }],
    ['generation fraction', { ...ACTIVATION, runtimeRoute: route({ runtimeGeneration: 1.5 }) }],
    ['generation string', { ...ACTIVATION, runtimeRoute: route({ runtimeGeneration: '1' }) }],
    ['publication 0', { ...ACTIVATION, runtimeRoute: route({ registryPublicationGeneration: 0 }) }],
    [
      'publication fraction',
      { ...ACTIVATION, runtimeRoute: route({ registryPublicationGeneration: 2.5 }) },
    ],
    [
      'inactive lifecycle',
      { ...ACTIVATION, runtimeRoute: route({ tenantLifecycleState: 'suspended' }) },
    ],
    ['inactive route', { ...ACTIVATION, runtimeRoute: route({ routeStatus: 'draining' }) }],
    ['targets not array', { ...ACTIVATION, runtimeRoute: route({ targets: 'x' }) }],
    [
      'null target',
      { ...ACTIVATION, runtimeRoute: route({ targets: [null, TARGETS[1], TARGETS[2]] }) },
    ],
    [
      'array target',
      { ...ACTIVATION, runtimeRoute: route({ targets: [[], TARGETS[1], TARGETS[2]] }) },
    ],
    [
      'target extra key',
      {
        ...ACTIVATION,
        runtimeRoute: route({ targets: [{ ...TARGETS[0], extra: 1 }, TARGETS[1], TARGETS[2]] }),
      },
    ],
    [
      'target missing key',
      {
        ...ACTIVATION,
        runtimeRoute: route({ targets: [{ dataRole: 'tenant_pii' }, TARGETS[1], TARGETS[2]] }),
      },
    ],
    [
      'unknown role',
      {
        ...ACTIVATION,
        runtimeRoute: route({ targets: [target('lookup', 'a', 'DB_A'), TARGETS[1], TARGETS[2]] }),
      },
    ],
    [
      'unsafe shard',
      {
        ...ACTIVATION,
        runtimeRoute: route({
          targets: [target('tenant_pii', '-a', 'DB_A'), TARGETS[1], TARGETS[2]],
        }),
      },
    ],
    [
      'lowercase binding',
      {
        ...ACTIVATION,
        runtimeRoute: route({
          targets: [target('tenant_pii', 'a', 'db_a'), TARGETS[1], TARGETS[2]],
        }),
      },
    ],
    [
      'digit binding',
      {
        ...ACTIVATION,
        runtimeRoute: route({
          targets: [target('tenant_pii', 'a', '1DB'), TARGETS[1], TARGETS[2]],
        }),
      },
    ],
    [
      'target generation 0',
      {
        ...ACTIVATION,
        runtimeRoute: route({
          targets: [target('tenant_pii', 'a', 'DB_A', 0), TARGETS[1], TARGETS[2]],
        }),
      },
    ],
    [
      'target generation fraction',
      {
        ...ACTIVATION,
        runtimeRoute: route({
          targets: [target('tenant_pii', 'a', 'DB_A', 1.5), TARGETS[1], TARGETS[2]],
        }),
      },
    ],
    [
      'duplicate role and shard',
      {
        ...ACTIVATION,
        runtimeRoute: route({
          targets: [TARGETS[0], { ...TARGETS[0], bindingRef: 'DB_Z' }, TARGETS[2]],
        }),
      },
    ],
    [
      'duplicate binding',
      {
        ...ACTIVATION,
        runtimeRoute: route({
          targets: [TARGETS[0], target('tenant_pii', 'other', 'DB_A'), TARGETS[2]],
        }),
      },
    ],
  ];

  it.each(invalid)('rejects %s', async (_name, input) => {
    const { repository, service } = build();
    await expect(service.activateTenantPlacementPolicy(input, 'env-1')).rejects.toThrow(
      /^invalid_tenant_placement_policy_activation$/u
    );
    expect(repository.activateTenantPlacementPolicy).not.toHaveBeenCalled();
  });

  it('allows the same shard under different roles but not the same role and shard', async () => {
    const { repository, service } = build();
    await service.activateTenantPlacementPolicy(
      {
        ...ACTIVATION,
        runtimeRoute: route({
          targets: [
            target('tenant_core/default', 'shared', 'DB_A'),
            target('tenant_core/users', 'shared', 'DB_B'),
            target('tenant_pii', 'shared', 'DB_C'),
          ],
        }),
      },
      'env-1'
    );
    expect(repository.activateTenantPlacementPolicy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['tenantId', 'invalid_tenant_id'],
    ['sourceOperationId', 'invalid_source_operation_id'],
    ['idempotencyKey', 'invalid_idempotency_key'],
  ])('rejects an unsafe %s', async (field, code) => {
    const { service } = build();
    await expect(
      service.activateTenantPlacementPolicy({ ...ACTIVATION, [field]: '-x' }, 'env-1')
    ).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
  });

  it('refuses a repository result that carries secret material', async () => {
    const { repository, service } = build();
    repository.activateTenantPlacementPolicy.mockResolvedValue({ private_key: 'x' });
    await expect(service.activateTenantPlacementPolicy(ACTIVATION, 'env-1')).rejects.toThrow(
      /control_plane_sensitive_key_forbidden/u
    );
  });
});

describe('getTenantPlacementPolicy', () => {
  it('reads by environment then tenant', async () => {
    const { repository, service } = build();
    await expect(service.getTenantPlacementPolicy('tenant-1', 'env-1')).resolves.toBe(POLICY);
    expect(repository.getTenantPlacementPolicy).toHaveBeenCalledExactlyOnceWith(
      'env-1',
      'tenant-1'
    );
  });

  it('returns null for an unknown tenant and validates identifiers first', async () => {
    const { repository, service } = build();
    repository.getTenantPlacementPolicy.mockResolvedValue(null);
    await expect(service.getTenantPlacementPolicy('tenant-1', 'env-1')).resolves.toBeNull();
    await expect(service.getTenantPlacementPolicy('-bad', 'env-1')).rejects.toThrow(
      /^invalid_tenant_id$/u
    );
    await expect(service.getTenantPlacementPolicy('tenant-1', '')).rejects.toThrow(
      /^invalid_environment_id$/u
    );
  });

  it('refuses a result carrying secret material', async () => {
    const { repository, service } = build();
    repository.getTenantPlacementPolicy.mockResolvedValue({ private_key: 'x' });
    await expect(service.getTenantPlacementPolicy('tenant-1', 'env-1')).rejects.toThrow(
      /control_plane_sensitive_key_forbidden/u
    );
  });
});
