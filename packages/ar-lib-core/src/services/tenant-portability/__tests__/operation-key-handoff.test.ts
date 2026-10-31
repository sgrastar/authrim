import { beforeAll, describe, expect, it } from 'vitest';
import {
  createTenantBundleKeyEnvelope,
  unlockTenantBundleKeyEnvelope,
  deriveTenantBundleStreamKey,
  type TenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import {
  openTenantBackupContentKey,
  type TenantBackupKeyHandoffContext,
} from '../operation-key-handoff';

const password = 'fixture backup password for handoff';
const context: TenantBackupKeyHandoffContext = {
  tenantId: 'tenant-a',
  operationId: 'operation-a',
  requestDigest: 'ab'.repeat(32),
  challengeId: 'challenge-a',
  expiresAt: 1000,
};
let pair: CryptoKeyPair;
let session: TenantBundleKeyEnvelope;
beforeAll(async () => {
  pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    false,
    ['encrypt', 'decrypt']
  );
  session = await createTenantBundleKeyEnvelope(password, { publicKey: pair.publicKey, context });
});

async function assertSameKey(a: CryptoKey, b: CryptoKey) {
  const salt = new Uint8Array(32).fill(7);
  const first = await deriveTenantBundleStreamKey(a, salt);
  const second = await deriveTenantBundleStreamKey(b, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(12) },
    first,
    new Uint8Array([4, 5, 6])
  );
  expect(
    new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, second, ciphertext)
    )
  ).toEqual(new Uint8Array([4, 5, 6]));
}

describe('operation-bound browser to Worker key handoff', () => {
  it('transfers the generated DEK without sending the password or exporting the HKDF key', async () => {
    const received = await openTenantBackupContentKey(
      session.handoff!,
      session.envelope,
      pair.privateKey,
      context,
      999
    );
    expect(received.contentKey.extractable).toBe(false);
    expect(received.handoff).toBeUndefined();
    await assertSameKey(session.contentKey, received.contentKey);
  });
  it('unlocks an existing portable artifact for a new operation and recipient', async () => {
    const newPair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      false,
      ['encrypt', 'decrypt']
    );
    const target = { ...context, operationId: 'restore', challengeId: 'restore-challenge' };
    const unlocked = await unlockTenantBundleKeyEnvelope(session.envelope, password, {
      publicKey: newPair.publicKey,
      context: target,
    });
    const received = await openTenantBackupContentKey(
      unlocked.handoff!,
      unlocked.envelope,
      newPair.privateKey,
      target,
      999
    );
    expect(unlocked.envelope).toEqual(session.envelope);
    await assertSameKey(session.contentKey, received.contentKey);
    await expect(
      openTenantBackupContentKey(
        session.handoff!,
        session.envelope,
        newPair.privateKey,
        context,
        999
      )
    ).rejects.toThrow('invalid_backup_key_handoff');
  });
  it.each([
    { tenantId: 'tenant-b' },
    { operationId: 'operation-b' },
    { requestDigest: 'cd'.repeat(32) },
    { challengeId: 'challenge-b' },
    { expiresAt: 1001 },
  ])('rejects ciphertext reused under a changed binding %j', async (change) => {
    await expect(
      openTenantBackupContentKey(
        session.handoff!,
        session.envelope,
        pair.privateKey,
        { ...context, ...change },
        999
      )
    ).rejects.toThrow('invalid_backup_key_handoff');
  });
  it('rejects expiry, altered envelopes, truncation and changed ciphertext', async () => {
    for (const now of [1000, 1001, -1, NaN])
      await expect(
        openTenantBackupContentKey(
          session.handoff!,
          session.envelope,
          pair.privateKey,
          context,
          now
        )
      ).rejects.toThrow('invalid_backup_key_handoff');
    const envelope = session.envelope.slice();
    envelope[20] ^= 1;
    await expect(
      openTenantBackupContentKey(session.handoff!, envelope, pair.privateKey, context, 999)
    ).rejects.toThrow('invalid_backup_key_handoff');
    const changed = session.handoff!.slice();
    changed[0] ^= 1;
    for (const ciphertext of [changed, changed.slice(1)])
      await expect(
        openTenantBackupContentKey(ciphertext, session.envelope, pair.privateKey, context, 999)
      ).rejects.toThrow('invalid_backup_key_handoff');
  });
});
