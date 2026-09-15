import { describe, expect, it, vi } from 'vitest';
import {
  decryptUpstreamProviderSecret,
  encryptUpstreamProviderSecret,
} from '../portable-upstream-provider-secrets.js';
import {
  exportPortableLinkedIdentityTokensRow,
  portableLinkedIdentityTokens,
  restorePortableLinkedIdentityTokens,
  verifyPortableLinkedIdentityTokens,
} from '../portable-linked-identity-tokens.js';

const sourceKey = '11'.repeat(32);
const targetKey = '22'.repeat(32);
const policy = { dataset: { id: 'pii.linked_identities' } } as never;
const manifest = { source: { tenantId: 'tenant-a' } } as never;

describe('portable linked identity tokens', () => {
  it('restores access and refresh tokens with Bridge-compatible target ciphertext', async () => {
    const source = JSON.stringify({
      id: ['text', 'link-a'],
      tenant_id: ['text', 'tenant-a'],
      access_token_encrypted: [
        'text',
        await encryptUpstreamProviderSecret('access-token', sourceKey),
      ],
      refresh_token_encrypted: [
        'text',
        await encryptUpstreamProviderSecret('refresh-token', sourceKey),
      ],
    });
    const rowJson = await exportPortableLinkedIdentityTokensRow(source, sourceKey);
    expect(portableLinkedIdentityTokens(JSON.parse(rowJson))).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    const stored = new Map<string, string>();
    const target = {
      writeSidecarText: vi.fn(async (_p, _m, _r, field, value, matches) => {
        stored.set(field, value);
        expect(await matches(value)).toBe(true);
      }),
      verifySidecarValue: vi.fn(async (_p, _m, _r, field, matches) => {
        expect(await matches(stored.get(field) ?? null)).toBe(true);
      }),
    } as never;
    await restorePortableLinkedIdentityTokens({
      target,
      policy,
      manifest,
      rowJson,
      targetKey,
    });
    expect(
      await decryptUpstreamProviderSecret(stored.get('access_token_encrypted')!, targetKey)
    ).toBe('access-token');
    expect(
      await decryptUpstreamProviderSecret(stored.get('refresh_token_encrypted')!, targetKey)
    ).toBe('refresh-token');
    await verifyPortableLinkedIdentityTokens({
      target,
      policy,
      manifest,
      rowJson,
      targetKey,
    });
  });

  it('keeps nullable refresh tokens null and rejects plaintext source tokens', async () => {
    const source = JSON.stringify({
      id: ['text', 'link-a'],
      tenant_id: ['text', 'tenant-a'],
      access_token_encrypted: [
        'text',
        await encryptUpstreamProviderSecret('access-token', sourceKey),
      ],
      refresh_token_encrypted: ['null', null],
    });
    const rowJson = await exportPortableLinkedIdentityTokensRow(source, sourceKey);
    expect(portableLinkedIdentityTokens(JSON.parse(rowJson)).refreshToken).toBeNull();
    await expect(
      exportPortableLinkedIdentityTokensRow(
        JSON.stringify({
          id: ['text', 'link-a'],
          tenant_id: ['text', 'tenant-a'],
          access_token_encrypted: ['text', 'plaintext'],
          refresh_token_encrypted: ['null', null],
        }),
        sourceKey
      )
    ).rejects.toThrow('backup_portable_linked_identity_token_invalid');
  });
});
