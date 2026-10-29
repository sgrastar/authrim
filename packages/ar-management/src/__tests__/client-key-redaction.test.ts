import { describe, expect, it } from 'vitest';
import {
  publicJwkSet,
  redactClientContract,
  redactResolutionDebug,
} from '../routes/policy/client-key-redaction';

const PUBLIC_RSA = { kty: 'RSA', kid: 'public', n: 'modulus', e: 'AQAB' };
const PRIVATE_RSA = {
  ...PUBLIC_RSA,
  d: 'exponent',
  p: 'prime',
  q: 'prime',
  dp: 'a',
  dq: 'b',
  qi: 'c',
};
const SYMMETRIC = { kty: 'oct', kid: 'shared', k: 'secret' };

describe('publicJwkSet', () => {
  it('keeps the public members and drops private and symmetric keys', () => {
    expect(
      publicJwkSet({
        keys: [PRIVATE_RSA, SYMMETRIC, { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' }],
      })
    ).toEqual({
      keys: [PUBLIC_RSA, { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }],
    });
  });

  it.each([undefined, null, 'text', [], {}, { keys: 'not-an-array' }])(
    'drops %j, which is not a key set',
    (value) => {
      expect(publicJwkSet(value)).toBeUndefined();
    }
  );
});

describe('redactClientContract', () => {
  it('redacts the key set and returns everything else as stored', () => {
    const contract = {
      version: 2,
      encryption: { encryptIdToken: true, jwks: { keys: [PRIVATE_RSA, SYMMETRIC] } },
      // Data that merely looks like a key, or holds a null, is not touched.
      scopes: {
        claimMappings: [{ transform: { mapping: [null, 'value'] } }],
        labels: { kty: 'category', p: 'value' },
      },
    };
    expect(redactClientContract(contract)).toEqual({
      ...contract,
      encryption: { encryptIdToken: true, jwks: { keys: [PUBLIC_RSA] } },
    });
  });

  it('drops a jwks that is not a key set and leaves a contract without one alone', () => {
    expect(redactClientContract({ encryption: { jwks: 'x', other: 1 } })).toEqual({
      encryption: { other: 1 },
    });
    const without = { encryption: { encryptIdToken: false } };
    expect(redactClientContract(without)).toBe(without);
    expect(redactClientContract(null)).toBeNull();
  });

  it('does not change the contract it is given', () => {
    const contract = { encryption: { jwks: { keys: [PRIVATE_RSA] } } };
    redactClientContract(contract);
    expect(contract.encryption.jwks.keys[0]).toHaveProperty('d');
  });
});

describe('redactResolutionDebug', () => {
  it('redacts the client keys echoed as the input of a step', () => {
    const debug = {
      cacheHit: false,
      steps: [
        {
          step: 'resolveEncryptionSettings',
          input: {
            tenant: { piiEncryptionRequired: true },
            client: { jwks: { keys: [PRIVATE_RSA] } },
          },
          output: { settings: {} },
        },
        { step: 'resolveSession', input: { tenant: { ttl: 1 } }, output: {} },
        { step: 'whole', input: { client: { encryption: { jwks: { keys: [SYMMETRIC] } } } } },
      ],
    };
    const redacted = redactResolutionDebug(debug);
    expect(JSON.stringify(redacted)).not.toMatch(/"d":|"k":|exponent|secret/);
    expect(redacted.steps[0].input.client).toEqual({ jwks: { keys: [PUBLIC_RSA] } });
    expect(redacted.steps[0].input.tenant).toEqual({ piiEncryptionRequired: true });
    expect(redacted.steps[1]).toBe(debug.steps[1]);
  });

  it('passes through a trace without steps', () => {
    expect(redactResolutionDebug(undefined)).toBeUndefined();
    expect(redactResolutionDebug({ cacheHit: true })).toEqual({ cacheHit: true });
  });
});
