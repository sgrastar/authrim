import { describe, expect, it } from 'vitest';
import {
  buildCanonicalTenantIssuerUrl,
  resolveTenantFromVanityHost,
} from '@authrim/ar-lib-core';
import { buildEnvForTopology, makeVanityHost, seedTenantDataset } from './helpers';

describe('tenant-system vanity domains', () => {
  it('resolves active validated vanity host to the tenant', async () => {
    const env = await buildEnvForTopology('D5_custom_vanity');
    await seedTenantDataset(env);

    const resolved = await resolveTenantFromVanityHost(
      env.DB,
      env.AUTHRIM_CONFIG,
      makeVanityHost('first')
    );

    expect(resolved).toBe('first');
  });

  it('does not resolve inactive or unvalidated vanity hosts', async () => {
    const env = await buildEnvForTopology('D5_custom_vanity');
    await seedTenantDataset(env);

    await expect(
      resolveTenantFromVanityHost(env.DB, env.AUTHRIM_CONFIG, makeVanityHost('second'))
    ).resolves.toBeNull();
    await expect(
      resolveTenantFromVanityHost(env.DB, env.AUTHRIM_CONFIG, 'old.first.example.test')
    ).resolves.toBeNull();
  });

  it('uses primary vanity host as canonical issuer', async () => {
    const env = await buildEnvForTopology('D5_custom_vanity');
    await seedTenantDataset(env);

    await expect(
      buildCanonicalTenantIssuerUrl(env, 'first', 'https://first.tenant-system.authrim.test')
    ).resolves.toBe('https://login.first.example.test');
  });
});
