import { describe, expect, it, vi } from 'vitest';
import { runPIIWriteWithCompensation } from '../pii-write-compensation';

describe('pii write compensation', () => {
  it('marks PII writes pending, active on success', async () => {
    const userCore = { updatePIIStatus: vi.fn().mockResolvedValue(true) };

    const result = await runPIIWriteWithCompensation({
      userId: 'user-1',
      userCore,
      requiresPIIWrite: true,
      write: vi.fn().mockResolvedValue('ok'),
    });

    expect(result).toEqual({ status: 'active', value: 'ok' });
    expect(userCore.updatePIIStatus).toHaveBeenNthCalledWith(1, 'user-1', 'pending');
    expect(userCore.updatePIIStatus).toHaveBeenNthCalledWith(2, 'user-1', 'active');
  });

  it('marks PII writes failed when the write throws', async () => {
    const userCore = { updatePIIStatus: vi.fn().mockResolvedValue(true) };
    const failure = new Error('pii write failed');

    await expect(
      runPIIWriteWithCompensation({
        userId: 'user-1',
        userCore,
        requiresPIIWrite: true,
        write: vi.fn().mockRejectedValue(failure),
      })
    ).rejects.toBe(failure);

    expect(userCore.updatePIIStatus).toHaveBeenNthCalledWith(1, 'user-1', 'pending');
    expect(userCore.updatePIIStatus).toHaveBeenNthCalledWith(2, 'user-1', 'failed');
  });

  it('does not touch pii_status when no PII write is required', async () => {
    const userCore = { updatePIIStatus: vi.fn().mockResolvedValue(true) };
    const write = vi.fn().mockResolvedValue('non-pii-ok');

    const result = await runPIIWriteWithCompensation({
      userId: 'user-1',
      userCore,
      requiresPIIWrite: false,
      write,
    });

    expect(result).toEqual({ status: 'not_required', value: 'non-pii-ok' });
    expect(write).toHaveBeenCalledOnce();
    expect(userCore.updatePIIStatus).not.toHaveBeenCalled();
  });
});
