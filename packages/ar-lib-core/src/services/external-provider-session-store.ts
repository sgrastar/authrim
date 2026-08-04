import type { Env } from '../types/env';
import type {
  ExternalProviderSessionIndexEntry,
  SessionRevocationStore,
} from '../durable-objects/SessionRevocationStore';

type ExternalProviderClaimKind = 'sid' | 'sub';

async function digestClaim(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getStore(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  tenantId: string,
  providerId: string,
  claimKind: ExternalProviderClaimKind,
  claim: string
): Promise<{ stub: DurableObjectStub<SessionRevocationStore>; digest: string }> {
  if (!env.SESSION_REVOCATION_STORE) throw new Error('external_provider_session_store_unavailable');
  const digest = await digestClaim(claim);
  const name = `tenant:${tenantId}:external-provider:${providerId}:${claimKind}:${digest}`;
  const namespace = env.SESSION_REVOCATION_STORE;
  return { stub: namespace.get(namespace.idFromName(name)), digest };
}

export async function registerExternalProviderSession(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  input: {
    tenantId: string;
    providerId: string;
    providerSub: string;
    providerSid?: string;
    sessionId: string;
    userId: string;
    expiresAtMs: number;
  }
): Promise<void> {
  const claims: Array<{ kind: ExternalProviderClaimKind; value: string }> = [
    { kind: 'sub', value: input.providerSub },
  ];
  if (input.providerSid) claims.push({ kind: 'sid', value: input.providerSid });
  await Promise.all(
    claims.map(async ({ kind, value }) => {
      const { stub, digest } = await getStore(env, input.tenantId, input.providerId, kind, value);
      await stub.registerExternalProviderSessionRpc(
        input.tenantId,
        input.providerId,
        kind,
        digest,
        input.sessionId,
        input.userId,
        input.expiresAtMs
      );
    })
  );
}

export async function listExternalProviderSessions(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  input: {
    tenantId: string;
    providerId: string;
    claimKind: ExternalProviderClaimKind;
    claim: string;
    nowMs?: number;
  }
): Promise<ExternalProviderSessionIndexEntry[]> {
  const { stub, digest } = await getStore(
    env,
    input.tenantId,
    input.providerId,
    input.claimKind,
    input.claim
  );
  return stub.listExternalProviderSessionsRpc(
    input.tenantId,
    input.providerId,
    input.claimKind,
    digest,
    input.nowMs ?? Date.now()
  );
}
