import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuditLog: audit,
  getTenantIdFromContext: () => 'tenant-a',
}));

import {
  adminIdentifierSaltPutHandler,
  adminIdentifierSaltsListHandler,
} from '../identifier-salts';

/** A key manager that keeps salts as KeyManager.importSecretRpc does. */
function fakeKeyManager() {
  const kept = new Map<string, string>();
  const fingerprint = (value: string) => value.length.toString(16).padStart(16, '0');
  const stub = {
    importSecretRpc: vi.fn(
      async (input: { secretRef: string; value: string; replaceFingerprint?: string }) => {
        const current = kept.get(input.secretRef);
        if (current === input.value) {
          return { fingerprint: fingerprint(input.value), outcome: 'unchanged' };
        }
        if (current !== undefined && input.replaceFingerprint !== fingerprint(current)) {
          throw new Error('imported_secret_replace_mismatch');
        }
        kept.set(input.secretRef, input.value);
        return { fingerprint: fingerprint(input.value), outcome: current ? 'replaced' : 'created' };
      }
    ),
    listImportedSecretsRpc: vi.fn(async () =>
      [...kept].map(([secretRef, value]) => ({
        secretRef,
        fingerprint: fingerprint(value),
        updatedAt: 1,
      }))
    ),
  };
  return { kept, stub, namespace: { idFromName: (name: string) => name, get: () => stub } };
}

function app(keyManager?: ReturnType<typeof fakeKeyManager>) {
  const hono = new Hono<{ Bindings: Record<string, unknown> }>();
  hono.get('/salts', adminIdentifierSaltsListHandler as never);
  hono.put('/salts/:name', adminIdentifierSaltPutHandler as never);
  const env = keyManager ? { KEY_MANAGER: keyManager.namespace } : {};
  return {
    put: (name: string, body: unknown) =>
      hono.request(`/salts/${name}`, { method: 'PUT', body: JSON.stringify(body) }, env),
    list: () => hono.request('/salts', {}, env),
  };
}

describe('identifier salts API', () => {
  beforeEach(() => audit.mockClear());

  it('keeps a text salt as its UTF-8 bytes and a base64 salt as its bytes', async () => {
    const km = fakeKeyManager();
    const api = app(km);
    const text = await api.put('shibboleth', { value: 'café-salt', encoding: 'utf8' });
    expect(text.status).toBe(200);
    expect(km.kept.get('identifier-salt:import:shibboleth')).toBe(
      btoa(String.fromCharCode(...new TextEncoder().encode('café-salt')))
    );
    const bytes = await api.put('encoded', { value: 'AAEC/w==', encoding: 'base64' });
    expect(bytes.status).toBe(200);
    expect(km.kept.get('identifier-salt:import:encoded')).toBe('AAEC/w==');
  });

  it('never returns or audits the salt itself', async () => {
    const km = fakeKeyManager();
    const api = app(km);
    const put = await api.put('keycloak', { value: 'top-secret-salt', encoding: 'utf8' });
    const listed = await api.list();
    const everything = [await put.text(), await listed.text(), JSON.stringify(audit.mock.calls)];
    for (const text of everything) {
      expect(text).not.toContain('top-secret-salt');
      expect(text).not.toContain(btoa('top-secret-salt'));
    }
    expect(JSON.parse(everything[1])).toEqual({
      salts: [{ name: 'keycloak', fingerprint: expect.any(String) as string, updatedAt: 1 }],
    });
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'identifier_salt.created', resourceId: 'keycloak' })
    );
  });

  it('changes nothing for the same salt, and replaces only with the current fingerprint', async () => {
    const km = fakeKeyManager();
    const api = app(km);
    const first = await (await api.put('ssp', { value: 'salt-one', encoding: 'utf8' })).json();
    const again = await api.put('ssp', { value: 'salt-one', encoding: 'utf8' });
    expect(await again.json()).toMatchObject({ outcome: 'unchanged' });
    expect(audit).toHaveBeenCalledTimes(1);
    expect((await api.put('ssp', { value: 'salt-two!', encoding: 'utf8' })).status).toBe(409);
    const replaced = await api.put('ssp', {
      value: 'salt-two!',
      encoding: 'utf8',
      replaceFingerprint: (first as { fingerprint: string }).fingerprint,
    });
    expect(await replaced.json()).toMatchObject({ outcome: 'replaced' });
  });

  it('refuses bad names, encodings, values and fingerprints', async () => {
    const api = app(fakeKeyManager());
    for (const [name, body] of [
      ['Bad Name', { value: 'x', encoding: 'utf8' }],
      ['ok', { value: 'x', encoding: 'hex' }],
      ['ok', { value: '', encoding: 'utf8' }],
      ['ok', { value: 'not base64!', encoding: 'base64' }],
      ['ok', { value: 'x', encoding: 'utf8', replaceFingerprint: 'nope' }],
    ] as const) {
      expect((await api.put(name, body)).status, JSON.stringify([name, body])).toBe(400);
    }
  });

  it('answers 503 without a key manager', async () => {
    expect((await app().list()).status).toBe(503);
  });
});
