import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { getJITConfig } from '../services/identity-stitching';

function envWith(get: (key: string) => Promise<string | null>): Env {
  return { SETTINGS: { get } as unknown as KVNamespace } as Env;
}

const saved = (documents: Record<string, unknown>) =>
  envWith(async (key) => (key in documents ? JSON.stringify(documents[key]) : null));

describe('getJITConfig', () => {
  it('is enabled with nothing saved, as before', async () => {
    await expect(getJITConfig(saved({}), 'plain')).resolves.toMatchObject({ enabled: true });
  });

  it("follows the saved document, and the tenant's Settings API value over it", async () => {
    const documents = {
      jit_provisioning_config: { enabled: true, allowed_provider_ids: ['idp-a'] },
      'settings:tenant:acme:external-idp': { 'external_idp.jit_provisioning_enabled': false },
    };

    await expect(getJITConfig(saved(documents), 'acme')).resolves.toMatchObject({
      enabled: false,
      allowed_provider_ids: ['idp-a'],
    });
    await expect(getJITConfig(saved(documents), 'other')).resolves.toMatchObject({
      enabled: true,
    });
    // A saved document without `enabled: true` disables JIT, as the bridge always read it.
    await expect(
      getJITConfig(saved({ jit_provisioning_config: { default_role_id: 'r' } }), 'plain')
    ).resolves.toMatchObject({ enabled: false });
  });

  it('decides with the document as it is now, not a copy read earlier', async () => {
    let enabled = true;
    const env = envWith(async (key) =>
      key === 'jit_provisioning_config' ? JSON.stringify({ enabled }) : null
    );
    await expect(getJITConfig(env, 'acme')).resolves.toMatchObject({ enabled: true });
    enabled = false;
    await expect(getJITConfig(env, 'acme')).resolves.toMatchObject({ enabled: false });
  });

  it('is disabled when its settings cannot be read', async () => {
    const unreadableDocument = envWith(async (key) => {
      if (key === 'jit_provisioning_config') throw new Error('kv unavailable');
      return null;
    });
    await expect(getJITConfig(unreadableDocument, 'acme')).resolves.toMatchObject({
      enabled: false,
    });

    const brokenTenantSettings = envWith(async (key) =>
      key === 'settings:tenant:acme:external-idp' ? 'not json' : null
    );
    await expect(getJITConfig(brokenTenantSettings, 'acme')).resolves.toMatchObject({
      enabled: false,
    });

    const notAnObject = envWith(async (key) => (key === 'jit_provisioning_config' ? '[]' : null));
    await expect(getJITConfig(notAnObject, 'acme')).resolves.toMatchObject({ enabled: false });
  });

  it("lets the tenant's Settings API value enable JIT over a document that is not an object", async () => {
    const env = envWith(async (key) =>
      key === 'jit_provisioning_config'
        ? '[]'
        : key === 'settings:tenant:acme:external-idp'
          ? JSON.stringify({ 'external_idp.jit_provisioning_enabled': true })
          : null
    );
    await expect(getJITConfig(env, 'acme')).resolves.toMatchObject({ enabled: true });
  });
});
