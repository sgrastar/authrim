import { describe, expect, it } from 'vitest';
import { buildCanonicalTenantIssuerUrl, getPrimaryTenantVanityDomain } from '@authrim/ar-lib-core';
import { buildEnvForTopology, seedTenantDataset } from './helpers';

describe('tenant-system vanity domains', () => {
  it('loads the active primary vanity domain from the tenant core store', async () => {
    const env = await buildEnvForTopology('D5_custom_vanity');
    await seedTenantDataset(env);

    const resolved = await getPrimaryTenantVanityDomain({ ...env, tenantCoreDb: env.DB }, 'first');

    expect(resolved).toMatchObject({ tenant_id: 'first', hostname: 'login.first.example.test' });
  });

  it('does not select a pending vanity domain as canonical', async () => {
    const env = await buildEnvForTopology('D5_custom_vanity');
    await seedTenantDataset(env);

    await expect(
      getPrimaryTenantVanityDomain({ ...env, tenantCoreDb: env.DB }, 'second')
    ).resolves.toBeNull();
  });

  it('uses primary vanity host as canonical issuer', async () => {
    const env = await buildEnvForTopology('D5_custom_vanity');
    await seedTenantDataset(env);

    await expect(
      buildCanonicalTenantIssuerUrl(
        { ...env, tenantCoreDb: env.DB },
        'first',
        'https://first.tenant-system.authrim.test'
      )
    ).resolves.toBe('https://login.first.example.test');
  });
});
