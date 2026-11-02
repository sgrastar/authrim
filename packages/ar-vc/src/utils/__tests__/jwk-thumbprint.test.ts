import { describe, expect, it } from 'vitest';
import { calculateJwkThumbprint } from '../jwk-thumbprint';

describe('calculateJwkThumbprint', () => {
  it('matches the RFC 7638 section 3.1 example', async () => {
    await expect(
      calculateJwkThumbprint({
        kty: 'RSA',
        n: '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
        e: 'AQAB',
      })
    ).resolves.toBe('NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs');
  });

  it('ignores extra members and rejects incomplete keys', async () => {
    const key = { kty: 'EC', crv: 'P-256', x: 'x-value', y: 'y-value' };
    await expect(calculateJwkThumbprint({ ...key, kid: 'k', use: 'sig' } as never)).resolves.toBe(
      await calculateJwkThumbprint(key)
    );
    await expect(calculateJwkThumbprint({ kty: 'EC', crv: 'P-256', x: 'x' })).rejects.toThrow(
      'invalid_jwk'
    );
    await expect(calculateJwkThumbprint({ kty: 'oct' })).rejects.toThrow('unsupported_jwk_type');
  });
});
