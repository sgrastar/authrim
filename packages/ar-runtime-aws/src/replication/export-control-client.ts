import { createTenantBundleKeyEnvelope } from '@authrim/ar-lib-core/services/tenant-portability/bundle-key-envelope';
import type { TenantBackupKeyHandoffContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-key-handoff';

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export interface ReplicationExportOperation {
  id: string;
  state: string;
  phase: string;
  revision: number;
}

export function createReplicationExportControl(input: {
  origin: string;
  grantId: string;
  tenantId: string;
  credential: string;
  passphrase: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const origin = new URL(input.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== input.origin ||
    origin.username ||
    origin.password ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.grantId) ||
    !/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.tenantId) ||
    !/^[a-f0-9]{64}$/u.test(input.credential) ||
    input.passphrase.length < 16 ||
    input.passphrase.length > 1024
  )
    throw new Error('replication_export_configuration_invalid');
  const base = `${input.origin}/api/replication-backups/${encodeURIComponent(input.grantId)}/exports`;
  const transport = input.fetch ?? fetch;
  const rpc = async (suffix: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> => {
    const response = await transport(`${base}${suffix}`, {
      method,
      headers: {
        Authorization: `Bearer ${input.credential}`,
        'X-Tenant-Id': input.tenantId,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('replication_export_control_unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 512 * 1024) throw new Error('replication_export_control_invalid');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  };
  const operation = (value: unknown, expectedId: string): ReplicationExportOperation => {
    const op = value as ReplicationExportOperation;
    if (
      !op ||
      !/^replication-backup-[a-f0-9]{64}$/u.test(op.id) ||
      op.id !== expectedId ||
      !Number.isSafeInteger(op.revision) ||
      op.revision < 0 ||
      !['waiting', 'queued', 'running', 'ready'].includes(op.state) ||
      typeof op.phase !== 'string' ||
      op.phase.length > 128
    )
      throw new Error('replication_export_operation_failed');
    return { id: op.id, state: op.state, phase: op.phase, revision: op.revision };
  };
  return {
    /** One bounded scheduler step. The remote export itself persists and continues on its scheduler. */
    async advance(idempotencyKey: string): Promise<ReplicationExportOperation> {
      try {
        if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(idempotencyKey)) throw new Error();
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(JSON.stringify([input.grantId, idempotencyKey]))
        );
        const expectedId = `replication-backup-${hex(new Uint8Array(digest))}`;
        const created = operation(await rpc('', 'POST', { idempotencyKey }), expectedId);
        const suffix = `/${encodeURIComponent(created.id)}`;
        if (created.state !== 'waiting' || created.phase !== 'unlock')
          return operation(await rpc(suffix, 'GET'), expectedId);
        // Until start wins its revision CAS, replacing an abandoned challenge is safe: every
        // envelope uses the same locally-held passphrase. A running export never gets a new key.
        const challenge = (await rpc(`${suffix}/key-challenges`, 'POST')) as {
          publicKey: JsonWebKey;
          context: TenantBackupKeyHandoffContext;
          submitExpiresAt: number;
        };
        const now = (input.now ?? Date.now)();
        if (
          !Number.isSafeInteger(now) ||
          now < 0 ||
          challenge.context?.tenantId !== input.tenantId ||
          challenge.context.operationId !== created.id ||
          Object.keys(challenge.context).sort().join(',') !==
            'challengeId,expiresAt,operationId,requestDigest,tenantId' ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(challenge.context.challengeId) ||
          !/^[a-f0-9]{64}$/.test(challenge.context.requestDigest) ||
          !Number.isSafeInteger(challenge.submitExpiresAt) ||
          challenge.submitExpiresAt <= now ||
          !Number.isSafeInteger(challenge.context.expiresAt) ||
          challenge.context.expiresAt <= now ||
          challenge.publicKey?.kty !== 'RSA' ||
          ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((field) =>
            Object.hasOwn(challenge.publicKey, field)
          )
        )
          throw new Error();
        const publicKey = await crypto.subtle.importKey(
          'jwk',
          challenge.publicKey,
          { name: 'RSA-OAEP', hash: 'SHA-256' },
          false,
          ['encrypt']
        );
        const key = await createTenantBundleKeyEnvelope(input.passphrase, {
          publicKey,
          context: challenge.context,
        });
        if (!key.handoff) throw new Error();
        const accepted = (await rpc(
          `${suffix}/key-challenges/${encodeURIComponent(challenge.context.challengeId)}/accept`,
          'POST',
          { envelope: hex(key.envelope), handoff: hex(key.handoff) }
        )) as { accepted?: boolean };
        if (accepted?.accepted !== true) throw new Error();
        return operation(
          await rpc(`${suffix}/start`, 'POST', {
            revision: created.revision,
            challengeId: challenge.context.challengeId,
          }),
          expectedId
        );
      } catch {
        throw new Error('replication_export_control_unavailable');
      }
    },
  };
}
