import { beforeEach, expect, it, vi } from 'vitest';
import type { TenantBackupStepContext } from '../operation-executor';
import type { TenantBackupExecutionInventory } from '../execution-inventory';
import { runTenantBackupInputDecodeSequenceStep } from '../input-decode-sequence';

const mocks = vi.hoisted(() => ({
  decode: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  validation: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('../input-plan', () => ({
  runPlannedTenantBackupInputDecodeStep: (...args: unknown[]) => mocks.decode(...args),
}));
vi.mock('../validation-index', () => ({
  DatabaseTenantBundleReferenceIndex: {
    createOrResume: (...args: unknown[]) => mocks.validation(...args),
  },
}));

const bundles = ['ab'.repeat(16), 'cd'.repeat(16)];
const context = {
  operation: {
    id: 'operation',
    tenant_id: 'tenant',
    kind: 'import',
    state: 'running',
    phase: 'decode_input',
    cursor_json: JSON.stringify({ version: 1, inputOrdinal: 0 }),
  },
  lease: {
    tenantId: 'tenant',
    operationId: 'operation',
    owner: 'worker',
    fencingToken: 1,
  },
  signal: new AbortController().signal,
} as unknown as TenantBackupStepContext;
const head = { state: 'sealed', item_count: 2, chain_digest: 'ef'.repeat(32) };
const inventory = {
  headForLease: vi.fn(async () => head),
  readPage: vi.fn(async (ordinal: number) => [
    { ordinal, item_id: `backup-input:${bundles[ordinal]}` },
  ]),
} as unknown as TenantBackupExecutionInventory;
const database = {};
const bucket = {};
const session = { envelope: new Uint8Array(93), contentKey: {} as CryptoKey };
const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};
const dataset = {
  id: 'core.clients',
  module: 'applications' as const,
  kind: 'settings' as const,
  store: 'database' as const,
  schemaVersion: 1,
  disposition: 'include' as const,
};
const loadInput = vi.fn(async (_ordinal: number, bundleId: string) => ({
  session,
  expected: {
    bundleId,
    source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: '0.4.2' },
    selection,
    datasets: [dataset],
  },
}));
const now = () => 100;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validation.mockResolvedValue({});
  mocks.decode.mockResolvedValue({
    phase: 'decode_input',
    cursor: '{}',
    disposition: 'continue',
  });
});

function run(value: TenantBackupStepContext = context) {
  return runTenantBackupInputDecodeSequenceStep(value, {
    inventory,
    inputCount: 2,
    database,
    bucket,
    now,
    loadInput,
  } as never);
}

it('keeps one input ordinal until its authenticated footer is complete', async () => {
  expect(await run()).toEqual({
    phase: 'decode_input',
    cursor: JSON.stringify({ version: 1, inputOrdinal: 0 }),
    disposition: 'continue',
  });
  const inner = mocks.decode.mock.calls[0]?.[0] as TenantBackupStepContext;
  expect(JSON.parse(inner.operation.cursor_json ?? 'null')).toEqual({
    version: 2,
    bundleId: bundles[0],
  });
  expect(loadInput).toHaveBeenCalledWith(0, bundles[0]);
  expect(mocks.validation).not.toHaveBeenCalled();
});

it('advances inputs in order and creates one deterministic validation session after the last', async () => {
  mocks.decode.mockResolvedValue({
    phase: 'validate_input_modules',
    cursor: '{}',
    disposition: 'continue',
  });
  const second = await run();
  expect(second).toEqual({
    phase: 'decode_input',
    cursor: JSON.stringify({ version: 1, inputOrdinal: 1 }),
    disposition: 'continue',
  });
  const final = await run({
    ...context,
    operation: { ...context.operation, cursor_json: second.cursor },
  });
  expect(final.phase).toBe('validate_input_modules');
  const cursor = JSON.parse(final.cursor ?? 'null');
  expect(cursor).toMatchObject({ version: 1, inputOrdinal: 0, datasetIndex: 0 });
  expect(cursor.sessionId).toMatch(/^[a-f0-9]{64}$/);
  expect(mocks.validation).toHaveBeenCalledWith(database, cursor.sessionId, context.lease, now);
  expect(loadInput).toHaveBeenLastCalledWith(1, bundles[1]);
});

it('reuses the same validation identity when its create response is lost', async () => {
  mocks.decode.mockResolvedValue({
    phase: 'validate_input_modules',
    cursor: '{}',
    disposition: 'continue',
  });
  mocks.validation.mockRejectedValueOnce(new Error('response_lost')).mockResolvedValueOnce({});
  const last = {
    ...context,
    operation: {
      ...context.operation,
      cursor_json: JSON.stringify({ version: 1, inputOrdinal: 1 }),
    },
  };
  await expect(run(last)).rejects.toThrow('response_lost');
  await run(last);
  expect(mocks.validation.mock.calls[0]?.[1]).toBe(mocks.validation.mock.calls[1]?.[1]);
});

it('rejects an incomplete or reordered sealed input inventory before decoding', async () => {
  const wrongInventory = {
    headForLease: vi.fn(async () => ({ ...head, item_count: 1 })),
    readPage: inventory.readPage,
  } as unknown as TenantBackupExecutionInventory;
  await expect(
    runTenantBackupInputDecodeSequenceStep(context, {
      inventory: wrongInventory,
      inputCount: 2,
      database,
      bucket,
      now,
      loadInput,
    } as never)
  ).rejects.toThrow('sequence_invalid');
  expect(mocks.decode).not.toHaveBeenCalled();

  vi.mocked(inventory.readPage).mockResolvedValueOnce([
    { ordinal: 0, item_id: `backup-input:${bundles[1]}` } as never,
  ]);
  loadInput.mockRejectedValueOnce(new Error('input_order_changed'));
  await expect(run()).rejects.toThrow('input_order_changed');
  expect(loadInput).toHaveBeenCalledWith(0, bundles[1]);
  expect(mocks.decode).toHaveBeenCalledTimes(0);
});
