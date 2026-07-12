import { describe, expect, it } from 'vitest';
import {
  generateTotpBackupCodes,
  hashTotpBackupCode,
  normalizeTotpBackupCode,
} from '../totp-backup-codes';

describe('TOTP backup codes', () => {
  it('generates ten unique one-time codes by default', async () => {
    const codes = await generateTotpBackupCodes({
      tenantId: 'tenant-a',
      userId: 'user-a',
      secret: 'server-secret',
    });

    expect(codes).toHaveLength(10);
    expect(new Set(codes.map((code) => code.code)).size).toBe(10);
    expect(codes.every((code) => /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code.code))).toBe(
      true
    );
    expect(
      codes.every((code) => code.prefix === normalizeTotpBackupCode(code.code).slice(0, 4))
    ).toBe(true);
  });

  it('hashes normalized code values without storing the plaintext', async () => {
    const base = {
      tenantId: 'tenant-a',
      userId: 'user-a',
      secret: 'server-secret',
    };

    await expect(hashTotpBackupCode({ ...base, code: 'ABCD-EFGH-2345' })).resolves.toBe(
      await hashTotpBackupCode({ ...base, code: ' abcd efgh 2345 ' })
    );
  });
});
