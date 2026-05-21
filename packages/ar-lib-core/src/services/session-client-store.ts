import type { Env } from '../types/env';
import type { SessionClientStore } from '../durable-objects/SessionClientStore';
import type {
  HydratedSessionClientLogoutTargets,
  SessionClientRepository,
} from '../repositories/core/session-client';
import type { CreateSessionClientInput, SessionClient } from '../repositories/core/session-client';
import type { SessionClientRecord } from '../durable-objects/SessionClientStore';

export interface SessionClientStoreEnv {
  SESSION_CLIENT_STORE?: Env['SESSION_CLIENT_STORE'];
}

function sessionClientStoreName(tenantId: string, sessionId: string): string {
  return `${tenantId}:${sessionId}`;
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
  });
  return recordToSessionClient(record);
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

export async function resolveLogoutTargetsFromSessionClientStore(
  env: SessionClientStoreEnv,
  tenantId: string,
  sessionId: string,
  repository: SessionClientRepository
): Promise<HydratedSessionClientLogoutTargets | null> {
  const sessionClients = await listSessionClientsFromStore(env, tenantId, sessionId);
  if (!sessionClients) {
    return null;
  }
  return repository.hydrateLogoutTargetsFromSessionClients(sessionClients);
}
