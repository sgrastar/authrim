import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import type { AuthRuntimePorts } from '../../types/auth-runtime-ports';
import {
  getChallengeStoreByChallengeId,
  getChallengeStoreByUserId,
  getChallengeStoreForLease,
} from '../challenge-sharding';
import { getSessionRevocationStore } from '../../services/session-revocation-store';
import { getSessionStoreBySessionId, getSessionStoreForNewSession } from '../session-helper';

const SESSION_ID = 'g1:apac:0:session_abcdefghijklmnopqrstuv';

function bindings(ports: Partial<AuthRuntimePorts>): Env {
  return { AUTH_RUNTIME_PORTS: ports as AuthRuntimePorts } as Env;
}

describe('non-Worker authentication state routing', () => {
  it('selects a tenant-scoped challenge port before Cloudflare sharding', async () => {
    const store = { storeChallengeRpc: vi.fn() };
    const forIdentity = vi.fn(() => store);
    const env = bindings({ challenges: { forIdentity } as never });

    expect(await getChallengeStoreByChallengeId(env, 'challenge-a', 'tenant-a')).toBe(store);
    expect(await getChallengeStoreByUserId(env, 'user-a', 'tenant-b')).toBe(store);
    expect(getChallengeStoreForLease(env, 'lease-a', 'tenant-a')).toBe(store);
    expect(forIdentity.mock.calls).toEqual([
      [{ tenantId: 'tenant-a', kind: 'challenge', key: 'challenge-a' }],
      [{ tenantId: 'tenant-b', kind: 'user', key: 'user-a' }],
      [{ tenantId: 'tenant-a', kind: 'lease', key: 'lease-a' }],
    ]);
  });

  it('rejects a missing tenant or challenge identity before calling the port', async () => {
    const forIdentity = vi.fn();
    const env = bindings({ challenges: { forIdentity } as never });

    await expect(getChallengeStoreByChallengeId(env, 'challenge-a', '')).rejects.toThrow(
      'auth_runtime_challenge_identity_invalid'
    );
    await expect(getChallengeStoreByChallengeId(env, '', 'tenant-a')).rejects.toThrow(
      'auth_runtime_challenge_identity_invalid'
    );
    expect(forIdentity).not.toHaveBeenCalled();
  });

  it('selects account revocation state by both tenant and user', () => {
    const store = { advancePasskeyCounterRpc: vi.fn() };
    const forAccount = vi.fn(() => store);
    const env = bindings({ sessionRevocation: { forAccount } as never });

    expect(getSessionRevocationStore(env, 'tenant-a', 'user-a')).toBe(store);
    expect(forAccount).toHaveBeenCalledWith({ tenantId: 'tenant-a', userId: 'user-a' });
    expect(() => getSessionRevocationStore(env, 'tenant-a', '')).toThrow(
      'auth_runtime_account_identity_invalid'
    );
    expect(forAccount).toHaveBeenCalledTimes(1);
  });

  it('routes existing and new sessions by tenant and validated session ID', async () => {
    const store = { getSessionRpc: vi.fn() };
    const forSession = vi.fn(() => store);
    const newSessionId = vi.fn(() => SESSION_ID);
    const env = bindings({ sessions: { forSession, newSessionId } as never });

    expect(getSessionStoreBySessionId(env, SESSION_ID, 'tenant-a').stub).toBe(store);
    const created = await getSessionStoreForNewSession(env, 'tenant-b');
    expect(created.sessionId).toBe(SESSION_ID);
    expect(created.stub).toBe(store);
    expect(forSession.mock.calls).toEqual([
      [{ tenantId: 'tenant-a', sessionId: SESSION_ID }],
      [{ tenantId: 'tenant-b', sessionId: SESSION_ID }],
    ]);
    expect(newSessionId).toHaveBeenCalledWith({ tenantId: 'tenant-b' });
  });

  it('rejects a weak generated session ID before opening a session store', async () => {
    const forSession = vi.fn();
    const env = bindings({
      sessions: { newSessionId: () => 'g1:apac:0:session_short', forSession } as never,
    });

    await expect(getSessionStoreForNewSession(env, 'tenant-a')).rejects.toThrow(
      'auth_runtime_session_id_invalid'
    );
    expect(forSession).not.toHaveBeenCalled();
  });
});
