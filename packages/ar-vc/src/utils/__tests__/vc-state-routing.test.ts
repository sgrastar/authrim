import { describe, expect, it } from 'vitest';
import {
  generatePreAuthorizedCode,
  parsePreAuthorizedCode,
  parseProofNonce,
} from '../credential-offer-sharding';

describe('VC one-time state routing values', () => {
  const offerId = 'g2:apac:7:co_550e8400-e29b-41d4-a716-446655440000';
  const secret = 'abcdefghijklmnopqrstuvwxyzABCDEF';

  it('round-trips a pre-authorized code without losing generation, region, or shard', () => {
    const code = generatePreAuthorizedCode(offerId, secret);
    expect(parsePreAuthorizedCode(code)).toMatchObject({
      offerId,
      secret,
      generation: 2,
      regionKey: 'apac',
      shardIndex: 7,
    });
  });

  it('rejects short secrets and resource-type confusion', () => {
    expect(() => generatePreAuthorizedCode(offerId, 'short')).toThrow();
    expect(parsePreAuthorizedCode(`g2:apac:7:vp_request.${secret}`)).toBeNull();
    expect(parseProofNonce(`${offerId}.${secret}`)).toBeNull();
  });

  it('accepts only a nonce resource with an opaque secret', () => {
    const nonce = `g3:eu:1:cn_550e8400-e29b-41d4-a716-446655440000.${secret}`;
    expect(parseProofNonce(nonce)).toMatchObject({
      nonceId: 'g3:eu:1:cn_550e8400-e29b-41d4-a716-446655440000',
      secret,
      parsed: { generation: 3, regionKey: 'eu', shardIndex: 1 },
    });
  });
});
