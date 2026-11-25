import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, make } from './support/control-rpc-harness';

const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../saml-dr-writer-inventory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../saml-dr-writer-inventory')>()),
  verifyEnvironmentSamlDrWriterInventory: mocks.verify,
}));

beforeEach(() => vi.resetAllMocks());

const RECEIPT = { receipt: 'value' };

describe('inspectSamlDrWriterCoverage', () => {
  it('verifies the tenant inventory without a receipt when none is supplied', async () => {
    mocks.verify.mockResolvedValue({ covered: true });
    const { control, env } = make();
    await expect(
      invoke(control, 'inspectSamlDrWriterCoverage', { tenantId: 'tenant-1' })
    ).resolves.toEqual({
      covered: true,
    });
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(env, { tenantId: 'tenant-1' });
    expect(Object.keys(mocks.verify.mock.calls[0]?.[1] as object)).toEqual(['tenantId']);
  });

  it('forwards an expected receipt verbatim', async () => {
    mocks.verify.mockResolvedValue({ covered: false });
    const { control, env } = make();
    await invoke(control, 'inspectSamlDrWriterCoverage', {
      tenantId: 'tenant-1',
      expectedReceipt: RECEIPT,
    });
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(env, {
      tenantId: 'tenant-1',
      expectedReceipt: RECEIPT,
    });
  });

  it('treats an explicitly undefined receipt as absent', async () => {
    mocks.verify.mockResolvedValue({});
    await invoke(make().control, 'inspectSamlDrWriterCoverage', {
      tenantId: 'tenant-1',
      expectedReceipt: undefined,
    });
    expect(Object.keys(mocks.verify.mock.calls[0]?.[1] as object)).toEqual(['tenantId']);
  });

  it.each([
    [{ tenantId: 'tenant-1', extra: 1 }],
    [{ tenantId: 'tenant-1', expectedReceipt: RECEIPT, extra: 1 }],
    [{}],
    [{ expectedReceipt: RECEIPT }],
    [null],
    ['tenant-1'],
    [[]],
  ])('rejects %j as an invalid inventory request', async (input) => {
    await expect(invoke(make().control, 'inspectSamlDrWriterCoverage', input)).rejects.toThrow(
      /^invalid_saml_dr_writer_inventory$|^invalid_operation_id$/u
    );
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('rejects a malformed tenant id', async () => {
    await expect(
      invoke(make().control, 'inspectSamlDrWriterCoverage', { tenantId: '-bad' })
    ).rejects.toThrow(/^invalid_operation_id$/u);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('rejects callers outside ar-management and mismatched environments', async () => {
    await expect(
      invoke(make({ caller: 'ar-lib-core' }).control, 'inspectSamlDrWriterCoverage', {
        tenantId: 't',
      })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    await expect(
      invoke(make({ environmentId: 'other-env' }).control, 'inspectSamlDrWriterCoverage', {
        tenantId: 't',
      })
    ).rejects.toThrow('control_rpc_caller_unauthorized');
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it('masks verification failures', async () => {
    mocks.verify.mockRejectedValue(new Error('sql detail'));
    await expect(
      invoke(make().control, 'inspectSamlDrWriterCoverage', { tenantId: 't' })
    ).rejects.toThrow(/^control_internal_error$/u);
  });
});
