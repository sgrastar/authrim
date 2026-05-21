import { describe, expect, it } from 'vitest';
import { createLoggingId, createUuidV7 } from '../ids';
import { createOpaqueTenantKey } from '../tenant-key';

describe('logging ids', () => {
  it('creates prefixed UUIDv7 ids', () => {
    const id = createLoggingId('lmj', 1_700_000_000_000);

    expect(id).toMatch(/^lmj_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes the timestamp into UUIDv7 ordering bytes', () => {
    const first = createUuidV7(1_700_000_000_000, new Uint8Array(10).fill(1));
    const second = createUuidV7(1_700_000_000_001, new Uint8Array(10).fill(1));

    expect(first < second).toBe(true);
  });

  it('creates opaque tenant keys without raw tenant identity material', () => {
    const first = createOpaqueTenantKey();
    const second = createOpaqueTenantKey();

    expect(first).toMatch(/^t_[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('tenant');
  });
});
