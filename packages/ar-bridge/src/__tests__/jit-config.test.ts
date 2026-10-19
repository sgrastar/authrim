import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_IDP_SETTINGS_META,
  externalJitSignupPolicy,
  externalSignupProviderIds,
  legacyJitProvisioningValues,
  resolveEffectiveSettings,
  type Env,
} from '@authrim/ar-lib-core';
import { getJITConfig } from '../services/identity-stitching';

function envWith(get: (key: string) => Promise<string | null>): Env {
  return { SETTINGS: { get } as unknown as KVNamespace } as Env;
}

/**
 * Saved settings documents; an older `jit_provisioning_config` document is saved as the platform's
 * Settings API values, as the import saves it.
 */
const saved = (documents: Record<string, unknown>) => {
  const stored = { ...documents };
  if ('jit_provisioning_config' in stored) {
    stored['settings:platform:external-idp'] = legacyJitProvisioningValues(
      JSON.stringify(stored.jit_provisioning_config)
    );
    delete stored.jit_provisioning_config;
  }
  return envWith(async (key) => (key in stored ? JSON.stringify(stored[key]) : null));
};

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
      key === 'settings:platform:external-idp'
        ? JSON.stringify({ 'external_idp.jit_provisioning_enabled': enabled })
        : null
    );
    await expect(getJITConfig(env, 'acme')).resolves.toMatchObject({ enabled: true });
    enabled = false;
    await expect(getJITConfig(env, 'acme')).resolves.toMatchObject({ enabled: false });
  });

  it('is disabled when its settings cannot be read', async () => {
    const unreadableDocument = envWith(async (key) => {
      if (key === 'settings:platform:external-idp') throw new Error('kv unavailable');
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

    const notAnObject = envWith(async (key) =>
      key === 'settings:platform:external-idp' ? '[]' : null
    );
    await expect(getJITConfig(notAnObject, 'acme')).resolves.toMatchObject({ enabled: false });
  });

  it('reads every JIT setting, over the saved document field by field', async () => {
    const documents = {
      jit_provisioning_config: {
        enabled: true,
        require_verified_email: false,
        join_all_matching_orgs: true,
        allow_user_without_org: true,
        default_role_id: 'role_member',
        allow_unverified_domain_mappings: true,
        allowed_provider_ids: ['idp-a', 'idp-b'],
      },
      'settings:tenant:acme:external-idp': {
        'external_idp.jit_require_verified_email': true,
        'external_idp.jit_default_role_id': '',
      },
    };
    await expect(getJITConfig(saved(documents), 'acme')).resolves.toMatchObject({
      enabled: true,
      require_verified_email: true,
      join_all_matching_orgs: true,
      allow_user_without_org: true,
      default_role_id: '',
      allow_unverified_domain_mappings: true,
      allowed_provider_ids: ['idp-a', 'idp-b'],
    });
  });

  it('reads the defaults with nothing saved', async () => {
    await expect(getJITConfig(saved({}), 'plain')).resolves.toMatchObject({
      require_verified_email: true,
      join_all_matching_orgs: false,
      allow_user_without_org: true,
      default_role_id: 'role_end_user',
      allow_unverified_domain_mappings: false,
      allowed_provider_ids: null,
    });
  });

  it('reads fields a saved document leaves out as off, as the bridge used it as it is', async () => {
    await expect(
      getJITConfig(saved({ jit_provisioning_config: { enabled: true } }), 'plain')
    ).resolves.toMatchObject({
      enabled: true,
      require_verified_email: false,
      allow_user_without_org: false,
      default_role_id: '',
      allowed_provider_ids: null,
    });
  });

  it('keeps refusing every provider for a list none of whose entries named one exactly', async () => {
    for (const list of [[1, ''], [' '], [' idp-a '], ['idp-a,idp-b'], ' ', ',,', { length: 1 }]) {
      const documents = {
        jit_provisioning_config: { enabled: true, allowed_provider_ids: list },
        // Turning JIT on does not make the list allow every provider.
        'settings:tenant:acme:external-idp': { 'external_idp.jit_provisioning_enabled': true },
      };
      await expect(getJITConfig(saved(documents), 'acme')).resolves.toMatchObject({
        enabled: true,
        allowed_provider_ids: ['-'],
      });
    }
    await expect(
      getJITConfig(
        saved({ jit_provisioning_config: { enabled: true, allowed_provider_ids: ['idp-a', ' '] } }),
        'plain'
      )
    ).resolves.toMatchObject({ allowed_provider_ids: ['idp-a'] });
  });

  it('carries over an older string list, and allows every provider only where the bridge did', async () => {
    const read = (allowed: unknown) =>
      getJITConfig(
        saved({ jit_provisioning_config: { enabled: true, allowed_provider_ids: allowed } }),
        'plain'
      );
    await expect(read('idp-a, idp-b')).resolves.toMatchObject({
      allowed_provider_ids: ['idp-a', 'idp-b'],
    });
    for (const allowed of [null, '', [], 0, true, {}]) {
      await expect(read(allowed)).resolves.toMatchObject({ allowed_provider_ids: null });
    }
  });

  it('allows every provider only for an empty list, not for one that names none', async () => {
    for (const value of [' ', ',,', ' , ']) {
      await expect(
        getJITConfig(
          saved({
            'settings:tenant:acme:external-idp': { 'external_idp.jit_allowed_provider_ids': value },
          }),
          'acme'
        )
      ).resolves.toMatchObject({ allowed_provider_ids: ['-'] });
    }
  });

  it('turns JIT off for a value of the wrong type rather than allowing more', async () => {
    for (const value of [
      { 'external_idp.jit_allowed_provider_ids': ['idp-a'] },
      { 'external_idp.jit_require_verified_email': 'true' },
      { 'external_idp.jit_default_role_id': 7 },
    ]) {
      await expect(
        getJITConfig(saved({ 'settings:tenant:acme:external-idp': value }), 'acme')
      ).resolves.toMatchObject({ enabled: false });
    }
  });
});

/**
 * The sign-up prediction for prompt=create (ar-lib-core) must say "no" exactly where the bridge
 * refuses to create accounts because of the tenant's JIT settings.
 */
describe('getJITConfig and the sign-up prediction read the JIT settings alike', () => {
  const providers = [{ id: 'idp-a', slug: 'a', enabled: true, jitProvisioning: true }];
  const badValues: Array<[string, unknown]> = [
    ['text', 'maybe'],
    ['a number', 7],
    ['zero', 0],
    ['null', null],
    ['a list', ['x']],
    ['an object', { a: 1 }],
    ['an empty text', ''],
    ['the text "true"', 'true'],
  ];

  async function bothFor(tenantValues: Record<string, unknown>) {
    const env = saved({ 'settings:tenant:acme:external-idp': tenantValues });
    const config = await getJITConfig(env, 'acme');
    const policy = externalJitSignupPolicy(
      await resolveEffectiveSettings(env, 'external-idp', { tenantId: 'acme' })
    );
    const predicted = externalSignupProviderIds({
      authenticationMethods: null,
      providers,
      jit: policy,
    });
    return { bridgeCreates: config.enabled, predictedSignup: predicted.length > 0 };
  }

  it('agrees with nothing saved and with valid values', async () => {
    for (const values of [
      {},
      { 'external_idp.jit_provisioning_enabled': false },
      { 'external_idp.jit_require_verified_email': false },
      { 'external_idp.jit_default_role_id': '' },
      { 'external_idp.jit_allowed_provider_ids': 'idp-a' },
      { 'external_idp.jit_allowed_provider_ids': 'idp-b' },
    ]) {
      const { bridgeCreates, predictedSignup } = await bothFor(values);
      const allowed = values['external_idp.jit_allowed_provider_ids' as keyof typeof values];
      const listed = allowed === undefined || allowed === 'idp-a';
      expect(predictedSignup).toBe(bridgeCreates && listed);
    }
  });

  // Every external_idp setting, not only those the bridge checks: the two must agree on each.
  const keys = Object.keys(EXTERNAL_IDP_SETTINGS_META);
  it.each(keys.flatMap((key) => badValues.map(([label, value]) => [key, label, value] as const)))(
    '%s as %s',
    async (key, _label, value) => {
      const { bridgeCreates, predictedSignup } = await bothFor({ [key]: value });
      // Predicting a sign-up is never looser than the bridge, and here (one provider, no
      // allow list) it is exactly as strict.
      expect(predictedSignup).toBe(
        bridgeCreates && (key !== 'external_idp.jit_allowed_provider_ids' || value === '')
      );
    }
  );

  it('covers every key the bridge checks', () => {
    for (const key of [
      'external_idp.jit_provisioning_enabled',
      'external_idp.jit_require_verified_email',
      'external_idp.jit_join_all_matching_orgs',
      'external_idp.jit_allow_user_without_org',
      'external_idp.jit_allow_unverified_domain_mappings',
      'external_idp.jit_allowed_provider_ids',
      'external_idp.jit_default_role_id',
    ]) {
      expect(keys).toContain(key);
    }
  });
});
