import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_RELAY_PROTOCOL,
  constantTimeHexEqual,
  isDirectoryRelayClientMessage,
  relayProtocolVersionsCompatible,
} from '../directory-relay-protocol';

const base = { protocol: DIRECTORY_RELAY_PROTOCOL, protocol_version: 1, min_supported_version: 1 };

describe('directory relay protocol guards (mutation hardening)', () => {
  it('rejects non-hex input even when both sides are identical', () => {
    expect(constantTimeHexEqual('zz', 'zz')).toBe(false);
    expect(constantTimeHexEqual('ab', 'zz')).toBe(false);
    expect(constantTimeHexEqual('', '')).toBe(false);
    expect(constantTimeHexEqual('abcd', 'ABCD')).toBe(true);
  });

  it.each(['auth.response', 'verify.response', 'verify.error'])('accepts %s', (type) => {
    expect(isDirectoryRelayClientMessage({ ...base, type })).toBe(true);
  });

  it.each([
    ['null', null],
    ['string', 'auth.response'],
    ['array', [{ ...base, type: 'auth.response' }]],
    ['wrong protocol', { ...base, protocol: 'other', type: 'auth.response' }],
    ['missing versions', { protocol: DIRECTORY_RELAY_PROTOCOL, type: 'auth.response' }],
    ['incompatible version', { ...base, min_supported_version: 2, type: 'auth.response' }],
    ['unknown type', { ...base, type: 'challenge' }],
  ])('rejects %s', (_label, value) => {
    expect(isDirectoryRelayClientMessage(value)).toBe(false);
  });

  it('requires integer versions', () => {
    expect(
      relayProtocolVersionsCompatible({ protocol_version: 1.5, min_supported_version: 1 })
    ).toBe(false);
    expect(
      relayProtocolVersionsCompatible({ protocol_version: 1, min_supported_version: '1' })
    ).toBe(false);
    expect(relayProtocolVersionsCompatible({ protocol_version: 5, min_supported_version: 0 })).toBe(
      true
    );
  });
});
