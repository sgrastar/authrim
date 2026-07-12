import { describe, expect, it } from 'vitest';
import {
  buildDirectoryRelayAuthCanonical,
  constantTimeHexEqual,
  relayProtocolVersionsCompatible,
  signDirectoryRelayCanonical,
} from '../directory-relay-protocol';

describe('directory relay protocol', () => {
  it('signs the relay authentication challenge context', async () => {
    const canonical = buildDirectoryRelayAuthCanonical({
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      keyId: 'kid-active',
      protocolVersion: 1,
      minSupportedVersion: 1,
      challengeId: 'challenge-123',
      nonce: 'nonce-123',
      timestamp: '2026-06-23T00:00:00.000Z',
    });

    expect(canonical).toBe(
      [
        'AUTHRIM-WORDWARDEN-RELAY-HMAC-SHA256',
        'tenant-a',
        'wwcon_8K4M2Q9F7D3H6P1X',
        'kid-active',
        '1',
        '1',
        'challenge-123',
        'nonce-123',
        '2026-06-23T00:00:00.000Z',
      ].join('\n')
    );

    const signature = await signDirectoryRelayCanonical(canonical, 'active-secret');
    const tampered = await signDirectoryRelayCanonical(
      canonical.replace('wwcon_8K4M2Q9F7D3H6P1X', 'wwcon_B7N5R3T9Y2U4P6A8'),
      'active-secret'
    );

    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(constantTimeHexEqual(signature, signature.toUpperCase())).toBe(true);
    expect(constantTimeHexEqual(signature, tampered)).toBe(false);
    expect(constantTimeHexEqual(signature, `${signature}00`)).toBe(false);
  });

  it('rejects relay messages outside the supported protocol version window', () => {
    expect(relayProtocolVersionsCompatible({ protocol_version: 1, min_supported_version: 1 })).toBe(
      true
    );
    expect(relayProtocolVersionsCompatible({ protocol_version: 0, min_supported_version: 1 })).toBe(
      false
    );
    expect(relayProtocolVersionsCompatible({ protocol_version: 1, min_supported_version: 2 })).toBe(
      false
    );
  });
});
