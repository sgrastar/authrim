import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { unlockTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import { openTenantBackupContentKey } from '@authrim/ar-lib-core/services/tenant-portability/operation-key-handoff';
import { createReplicationExportControl } from './export-control-client';

const fromHex = (value: string): Uint8Array =>
  new Uint8Array((value.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));

const passphrase = 'synthetic only passphrase never sent';
const id =
  'replication-backup-' +
  createHash('sha256')
    .update(JSON.stringify(['grant-a', 'cycle-a']))
    .digest('hex');
let pair: CryptoKeyPair;
let publicKey: JsonWebKey;
beforeAll(async () => {
  pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt']
  );
  publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
});
function fixture() {
  const context = {
    tenantId: 'tenant-a',
    operationId: id,
    requestDigest: 'a'.repeat(64),
    challengeId: 'challenge-a',
    expiresAt: 10000,
  };
  const challenge = { publicKey: { ...publicKey }, context: { ...context }, submitExpiresAt: 2000 };
  const created = { id, state: 'waiting', phase: 'unlock', revision: 0 };
  const final = { id, state: 'queued', phase: 'prepare', revision: 1 };
  const bodies: unknown[] = [];
  const requests: string[] = [];
  let accepted: { envelope: string; handoff: string } | undefined;
  const transport: typeof fetch = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (typeof url !== 'string') throw new Error('expected URL string');
      const path = url;
      requests.push(path);
      expect(init?.redirect).toBe('error');
      expect(init?.cache).toBe('no-store');
      expect(new Headers(init?.headers).get('X-Tenant-Id')).toBe('tenant-a');
      expect(
        path.startsWith('https://source.example.test/api/replication-backups/grant-a/exports')
      ).toBe(true);
      if (init?.body !== undefined && typeof init.body !== 'string')
        throw new Error('expected JSON body');
      const body = init?.body === undefined ? undefined : (JSON.parse(init.body) as unknown);
      bodies.push(body);
      if (path.endsWith('/exports')) return Response.json(created, { status: 201 });
      if (path.endsWith('/key-challenges')) return Response.json(challenge, { status: 201 });
      if (path.endsWith('/accept')) {
        accepted = body as { envelope: string; handoff: string };
        return Response.json({ accepted: true });
      }
      if (path.endsWith('/start')) return Response.json(final, { status: 202 });
      return Response.json(final);
    }
  );
  const input = {
    origin: 'https://source.example.test',
    grantId: 'grant-a',
    tenantId: 'tenant-a',
    credential: 'b'.repeat(64),
    passphrase,
    fetch: transport,
    now: () => 1000,
  };
  return {
    input,
    context,
    challenge,
    created,
    final,
    bodies,
    requests,
    transport,
    accepted: () => accepted,
  };
}
describe('delegated export control client', () => {
  it('uses real envelope crypto and sends neither passphrase nor content key over HTTP', async () => {
    const f = fixture();
    expect(await createReplicationExportControl(f.input).advance('cycle-a')).toEqual(f.final);
    expect(f.requests).toHaveLength(4);
    expect(f.bodies[0]).toEqual({ idempotencyKey: 'cycle-a' });
    expect(f.bodies[3]).toEqual({ revision: 0, challengeId: 'challenge-a' });
    expect(JSON.stringify(f.bodies)).not.toContain(passphrase);
    expect(JSON.stringify(f.bodies)).not.toContain(f.input.credential);
    const accepted = f.accepted();
    expect(accepted).toBeDefined();
    if (!accepted) throw new Error('expected acceptance');
    expect(accepted.envelope).toMatch(/^[a-f0-9]{186}$/);
    expect(accepted.handoff).toMatch(/^[a-f0-9]{512}$/);
    const envelope = fromHex(accepted.envelope);
    const opened = await openTenantBackupContentKey(
      fromHex(accepted.handoff),
      envelope,
      pair.privateKey,
      f.context,
      1000
    );
    const unlocked = await unlockTenantBundleKeyEnvelope(envelope, passphrase);
    const algorithm = {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(16),
      info: new TextEncoder().encode('test-content-key'),
    };
    const left = await crypto.subtle.deriveKey(
      algorithm,
      opened.contentKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt']
    );
    const right = await crypto.subtle.deriveKey(
      algorithm,
      unlocked.contentKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt']
    );
    expect(new Uint8Array(await crypto.subtle.exportKey('raw', left))).toEqual(
      new Uint8Array(await crypto.subtle.exportKey('raw', right))
    );
  });
  it.each([
    'tenant',
    'operation',
    'expired-submit',
    'expired-key',
    'input-id',
    'bad-digest',
    'bad-challenge',
    'private-key',
  ] as const)('rejects %s challenge before submitting any envelope', async (kind) => {
    const f = fixture();
    if (kind === 'tenant') f.challenge.context.tenantId = 'tenant-b';
    if (kind === 'operation') f.challenge.context.operationId = 'other';
    if (kind === 'expired-submit') f.challenge.submitExpiresAt = 1000;
    if (kind === 'expired-key') f.challenge.context.expiresAt = 1000;
    if (kind === 'input-id') Object.assign(f.challenge.context, { inputId: 'import-a' });
    if (kind === 'bad-digest') f.challenge.context.requestDigest = 'bad';
    if (kind === 'bad-challenge') f.challenge.context.challengeId = 'other/path';
    if (kind === 'private-key') f.challenge.publicKey.p = 'private';
    await expect(createReplicationExportControl(f.input).advance('cycle-a')).rejects.toThrow(
      'replication_export_control_unavailable'
    );
    expect(f.accepted()).toBeUndefined();
    expect(f.requests).toHaveLength(2);
  });
  it.each(['created', 'status', 'started'] as const)(
    'rejects cross-operation %s response',
    async (kind) => {
      const f = fixture();
      if (kind === 'created') f.created.id = 'replication-backup-' + 'c'.repeat(64);
      else f.final.id = 'replication-backup-' + 'c'.repeat(64);
      if (kind === 'status') {
        f.created.state = 'running';
        f.created.phase = 'export_artifact';
      }
      await expect(createReplicationExportControl(f.input).advance('cycle-a')).rejects.toThrow(
        'replication_export_control_unavailable'
      );
      if (kind === 'created') expect(f.requests).toHaveLength(1);
      if (kind === 'status') expect(f.accepted()).toBeUndefined();
    }
  );
  it('observes already-running exports without replacing accepted keys', async () => {
    const f = fixture();
    f.created.state = 'running';
    f.created.phase = 'export_artifact';
    f.final.state = 'ready';
    f.final.phase = 'export_complete';
    expect(await createReplicationExportControl(f.input).advance('cycle-a')).toEqual(f.final);
    expect(f.requests).toHaveLength(2);
    expect(f.accepted()).toBeUndefined();
  });
  it.each([302, 403, 500])(
    'redacts failed transport %i without following redirects or exposing credentials',
    async (status) => {
      const f = fixture();
      f.input.fetch = vi.fn(
        async () =>
          new Response('PRIVATE ' + passphrase, {
            status,
            headers: { Location: 'https://other.example.test' },
          })
      );
      await expect(createReplicationExportControl(f.input).advance('cycle-a')).rejects.toThrow(
        'replication_export_control_unavailable'
      );
    }
  );
  it('bounds control responses before parsing', async () => {
    const f = fixture();
    f.input.fetch = vi.fn(async () => new Response('x'.repeat(512 * 1024 + 1)));
    await expect(createReplicationExportControl(f.input).advance('cycle-a')).rejects.toThrow(
      'replication_export_control_unavailable'
    );
  });
});
