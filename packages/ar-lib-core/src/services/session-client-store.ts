import type { Env } from '../types/env';
import type { SessionClientStore } from '../durable-objects/SessionClientStore';
import type {
  HydratedSessionClientLogoutTargets,
  SessionClientRepository,
} from '../repositories/core/session-client';
import type { CreateSessionClientInput, SessionClient } from '../repositories/core/session-client';
import type { SessionClientRecord } from '../durable-objects/SessionClientStore';
import { deriveOidcSid } from '../utils/session-helper';
import { createLogger } from '../utils/logger';

const log = createLogger().module('SESSION-CLIENT-STORE');
const LEGACY_DISCOVERY_CONCURRENCY = 20;

export interface SessionClientStoreEnv {
  SESSION_CLIENT_STORE?: Env['SESSION_CLIENT_STORE'];
}

function sessionClientStoreName(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
}

function oidcSidAliasStoreName(tenantId: string, oidcSid: string): string {
  return `${tenantId}:oidc-sid:${oidcSid}`;
}

function getSessionClientStoreStub(
  env: SessionClientStoreEnv,
  tenantId: string,
  sessionId: string
): DurableObjectStub<SessionClientStore> | null {
  if (!env.SESSION_CLIENT_STORE) {
    return null;
  }
  const id = env.SESSION_CLIENT_STORE.idFromName(sessionClientStoreName(tenantId, sessionId));
  return env.SESSION_CLIENT_STORE.get(id);
}

function recordToSessionClient(record: SessionClientRecord): SessionClient {
  return {
    id: record.id,
    tenant_id: record.tenant_id,
    session_id: record.session_id,
    client_id: record.client_id,
    ...(record.oidc_sid ? { oidc_sid: record.oidc_sid } : {}),
    first_token_at: record.first_token_at,
    last_token_at: record.last_token_at,
    last_seen_at: record.last_seen_at,
  };
}

export async function registerSessionClientInStore(
  env: SessionClientStoreEnv,
  tenantId: string,
  input: CreateSessionClientInput
): Promise<SessionClient | null> {
  const stub = getSessionClientStoreStub(env, tenantId, input.session_id);
  if (!stub) {
    return null;
  }

  const record = await stub.registerClientRpc({
    tenantId,
    sessionId: input.session_id,
    clientId: input.client_id,
    oidcSid: input.oidc_sid,
  });

  if (input.oidc_sid && env.SESSION_CLIENT_STORE) {
    const aliasId = env.SESSION_CLIENT_STORE.idFromName(
      oidcSidAliasStoreName(tenantId, input.oidc_sid)
    );
    await env.SESSION_CLIENT_STORE.get(aliasId).registerOidcSidAliasRpc({
      tenantId,
      oidcSid: input.oidc_sid,
      sessionId: input.session_id,
    });
  }
  return recordToSessionClient(record);
}

export async function resolveSessionIdFromOidcSidStore(
  env: SessionClientStoreEnv,
  tenantId: string,
  oidcSid: string
): Promise<string | null> {
  if (!env.SESSION_CLIENT_STORE) {
    return null;
  }
  const aliasId = env.SESSION_CLIENT_STORE.idFromName(oidcSidAliasStoreName(tenantId, oidcSid));
  return env.SESSION_CLIENT_STORE.get(aliasId).resolveOidcSidAliasRpc({ tenantId, oidcSid });
}

export async function listSessionClientsFromStore(
  env: SessionClientStoreEnv,
  tenantId: string,
  sessionId: string
): Promise<SessionClient[] | null> {
  const stub = getSessionClientStoreStub(env, tenantId, sessionId);
  if (!stub) {
    return null;
  }

  const records = await stub.listClientsRpc({ tenantId, sessionId });
  return records.map(recordToSessionClient);
}

async function loadLegacyCodeFlowRecord(
  env: SessionClientStoreEnv,
  tenantId: string,
  oidcSid: string,
  clientId: string
): Promise<SessionClientRecord | null> {
  const legacyStub = getSessionClientStoreStub(env, tenantId, oidcSid);
  if (!legacyStub) return null;

  try {
    const records = await legacyStub.listClientsRpc({ tenantId, sessionId: oidcSid });
    return (
      records.find(
        (record) =>
          record.tenant_id === tenantId &&
          record.session_id === oidcSid &&
          record.client_id === clientId
      ) ?? null
    );
  } catch (error) {
    log.warn('Failed to inspect legacy code-flow session-client record', {
      clientId,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return null;
  }
}

async function repairClientForRawSession(
  env: SessionClientStoreEnv,
  tenantId: string,
  sessionId: string,
  issuer: string,
  record: SessionClientRecord
): Promise<SessionClient> {
  const oidcSid = record.oidc_sid ?? (await deriveOidcSid(sessionId, record.client_id, issuer));
  const repaired: SessionClient = {
    ...recordToSessionClient(record),
    session_id: sessionId,
    oidc_sid: oidcSid,
  };

  try {
    return (
      (await registerSessionClientInStore(env, tenantId, {
        session_id: sessionId,
        client_id: record.client_id,
        oidc_sid: oidcSid,
      })) ?? repaired
    );
  } catch (error) {
    // The current logout can still send the correct RP-facing sid from the repaired
    // in-memory record. Keep the durable failure visible for operational repair.
    log.warn('Failed to persist repaired session-client record', {
      clientId: record.client_id,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return repaired;
  }
}

async function discoverLegacyCodeFlowClients(
  env: SessionClientStoreEnv,
  tenantId: string,
  sessionId: string,
  issuer: string,
  clientIds: string[]
): Promise<SessionClient[]> {
  const discovered: SessionClient[] = [];
  for (let offset = 0; offset < clientIds.length; offset += LEGACY_DISCOVERY_CONCURRENCY) {
    const batch = clientIds.slice(offset, offset + LEGACY_DISCOVERY_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (clientId) => {
        const oidcSid = await deriveOidcSid(sessionId, clientId, issuer);
        const record = await loadLegacyCodeFlowRecord(env, tenantId, oidcSid, clientId);
        if (!record) return null;
        return repairClientForRawSession(env, tenantId, sessionId, issuer, {
          ...record,
          oidc_sid: oidcSid,
        });
      })
    );
    discovered.push(...results.filter((value): value is SessionClient => value !== null));
  }
  return discovered;
}

export async function resolveLogoutTargetsFromSessionClientStore(
  env: SessionClientStoreEnv,
  tenantId: string,
  sessionId: string,
  repository: SessionClientRepository,
  issuer: string
): Promise<HydratedSessionClientLogoutTargets | null> {
  const storedClients = await listSessionClientsFromStore(env, tenantId, sessionId);
  if (!storedClients) {
    return null;
  }

  const sessionClients = await Promise.all(
    storedClients.map((client) =>
      client.oidc_sid
        ? Promise.resolve(client)
        : repairClientForRawSession(env, tenantId, sessionId, issuer, client)
    )
  );

  // Old code-flow records were stored in a DO named from the derived sid instead
  // of the raw session key. Probe only logout-capable clients, and only while the
  // raw store is empty or contains a legacy record.
  if (storedClients.length === 0 || storedClients.some((client) => !client.oidc_sid)) {
    const knownClientIds = new Set(sessionClients.map((client) => client.client_id));
    const candidateClientIds = (await repository.listLogoutCandidateClientIds()).filter(
      (clientId) => !knownClientIds.has(clientId)
    );
    sessionClients.push(
      ...(await discoverLegacyCodeFlowClients(env, tenantId, sessionId, issuer, candidateClientIds))
    );
  }

  return repository.hydrateLogoutTargetsFromSessionClients(sessionClients);
}

export async function resolveLegacyLogoutTargetsFromOidcSidStore(
  env: SessionClientStoreEnv,
  tenantId: string,
  oidcSid: string,
  clientId: string,
  repository: SessionClientRepository
): Promise<HydratedSessionClientLogoutTargets | null> {
  const record = await loadLegacyCodeFlowRecord(env, tenantId, oidcSid, clientId);
  if (!record) return null;
  return repository.hydrateLogoutTargetsFromSessionClients([
    {
      ...recordToSessionClient(record),
      oidc_sid: oidcSid,
    },
  ]);
}
