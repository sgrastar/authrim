import { describe, expect, it } from 'vitest';
import {
  buildDirectoryRelayAuthCanonical,
  constantTimeHexEqual,
  signDirectoryRelayCanonical,
} from '../directory-relay-protocol';

describe('directory relay protocol', () => {
  it('signs the relay authentication challenge context', async () => {
    const canonical = buildDirectoryRelayAuthCanonical({
      tenantId: 'tenant-a',
      connectorId: 'ww_tenant_a',
      keyId: 'kid-active',
      challengeId: 'challenge-123',
      nonce: 'nonce-123',
      timestamp: '2026-06-23T00:00:00.000Z',
    });

    expect(canonical).toBe(
      [
        'AUTHRIM-WORDWARDEN-RELAY-HMAC-SHA256',
        'tenant-a',
        'ww_tenant_a',
        'kid-active',
        'challenge-123',
        'nonce-123',
        '2026-06-23T00:00:00.000Z',
      ].join('\n')
    );

    const signature = await signDirectoryRelayCanonical(canonical, 'active-secret');
    const tampered = await signDirectoryRelayCanonical(
      canonical.replace('ww_tenant_a', 'ww_tenant_b'),
      'active-secret'
    );

    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(constantTimeHexEqual(signature, signature.toUpperCase())).toBe(true);
    expect(constantTimeHexEqual(signature, tampered)).toBe(false);
    expect(constantTimeHexEqual(signature, `${signature}00`)).toBe(false);
  });
});
