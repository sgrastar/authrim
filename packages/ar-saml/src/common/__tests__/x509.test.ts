import { describe, expect, it } from 'vitest';
import { extractSubjectPublicKeyInfo } from '../x509';

describe('X.509 DER parsing', () => {
  it('rejects truncated long-form lengths instead of reading past the input', () => {
    expect(() => extractSubjectPublicKeyInfo(Uint8Array.from([0x30, 0x82, 0x01]))).toThrow(
      'Invalid DER certificate length'
    );
  });
});
