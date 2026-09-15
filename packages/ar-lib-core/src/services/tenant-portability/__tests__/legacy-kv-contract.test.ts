import { describe, expect, it } from 'vitest';
import { CONFIG_NAMES } from '../../../utils/oauth-config';
import { buildContractKey } from '../../../utils/contract-loader';
import type { Env } from '../../../types/env';
import { VC_CONFIG_NAMES } from '../../../../../ar-vc/src/utils/vc-config';
import {
  classifyLegacyKvKey,
  LEGACY_OAUTH_SETTING_NAMES,
  LEGACY_VC_SETTING_NAMES,
} from '../legacy-kv-contract';

const context = { tenantId: 'tenant-a', clientIds: new Set(['client-a']) };

describe('reviewed legacy KV backup keys', () => {
  it('preserves canonical tenant and client policy keys produced by the runtime', () => {
    const env = { ENVIRONMENT: 'test' } as Env;
    const pinned = { ...context, environment: 'test' };
    expect(
      classifyLegacyKvKey('AUTHRIM_CONFIG', buildContractKey(env, 'tenant', 'tenant-a'), pinned)
    ).toEqual({ kind: 'tenant_setting', purpose: 'policy_contract' });
    expect(
      classifyLegacyKvKey(
        'AUTHRIM_CONFIG',
        buildContractKey(env, 'client', 'tenant-a', 'client-a'),
        pinned
      )
    ).toEqual({ kind: 'client_policy_contract', clientId: 'client-a' });
    expect(
      classifyLegacyKvKey('AUTHRIM_CONFIG', buildContractKey(env, 'tenant', 'tenant-b'), pinned)
    ).toEqual({ kind: 'foreign_tenant' });
  });

  it.each([
    ['AUTHRIM_CONFIG', 'prod:contract:tenant:tenant-a'],
    ['SETTINGS', 'test:contract:tenant:tenant-a'],
    ['AUTHRIM_CONFIG', 'test:contract:tenant:tenant-a:client-a'],
    ['AUTHRIM_CONFIG', 'test:contract:client:tenant-a'],
    ['AUTHRIM_CONFIG', 'test:contract:client:tenant-a:client-b'],
    ['AUTHRIM_CONFIG', 'test:contract:client:tenant-a:client-a:extra'],
  ])('rejects unpinned or malformed policy ownership: %s / %s', (binding, key) => {
    expect(classifyLegacyKvKey(binding, key, { ...context, environment: 'test' })).toEqual({
      kind: 'unsupported',
    });
  });

  it('does not guess the source environment for policy contracts', () => {
    expect(classifyLegacyKvKey('AUTHRIM_CONFIG', 'dev:contract:tenant:tenant-a', context)).toEqual({
      kind: 'unsupported',
    });
  });
  it.each(['AUTHRIM_CONFIG', 'SETTINGS'])(
    'recognizes the dedicated email settings in %s',
    (binding) => {
      expect(
        classifyLegacyKvKey(binding, 'settings:tenant:tenant-a:email-settings', context)
      ).toEqual({
        kind: 'tenant_setting',
        purpose: 'email_provider_order',
      });
      expect(
        classifyLegacyKvKey(binding, 'settings:tenant:tenant-b:email-settings', context)
      ).toEqual({ kind: 'foreign_tenant' });
      expect(
        classifyLegacyKvKey(binding, 'settings:tenant:tenant-a:email-settings:extra', context)
      ).toEqual({ kind: 'unsupported' });
    }
  );

  it('requires review when OAuth or VC adds a dynamic setting', () => {
    expect([...LEGACY_OAUTH_SETTING_NAMES].sort()).toEqual([...CONFIG_NAMES].sort());
    expect([...LEGACY_VC_SETTING_NAMES].sort()).toEqual([...VC_CONFIG_NAMES].sort());
  });

  it('keeps shared configuration as a prerequisite instead of tenant-owned data', () => {
    for (const key of [
      'oauth:config:TOKEN_EXPIRY',
      'vc:config:REQUIRE_ISSUER_TRUST',
      'v1:cache-mode:platform',
    ]) {
      expect(classifyLegacyKvKey('AUTHRIM_CONFIG', key, context)).toEqual({
        kind: 'shared_setting_dependency',
      });
    }
    expect(classifyLegacyKvKey('AUTHRIM_CONFIG', 'session_shards', context)).toEqual({
      kind: 'placement_dependency',
    });
  });

  it('requires the pinned client inventory for legacy client overrides', () => {
    expect(classifyLegacyKvKey('AUTHRIM_CONFIG', 'v1:cache-mode:client:client-a', context)).toEqual(
      { kind: 'client_setting', clientId: 'client-a' }
    );
    expect(classifyLegacyKvKey('AUTHRIM_CONFIG', 'v1:cache-mode:client:client-b', context)).toEqual(
      { kind: 'unsupported' }
    );
  });

  it('retains the consent salt as a tenant secret independent of optional logs', () => {
    expect(classifyLegacyKvKey('KV', 'consent:ip_salt:tenant-a', context)).toEqual({
      kind: 'tenant_secret',
      category: 'users',
      purpose: 'consent_ip_hash',
    });
    expect(classifyLegacyKvKey('KV', 'consent:ip_salt:tenant-b', context)).toEqual({
      kind: 'foreign_tenant',
    });
  });

  it.each([
    ['SETTINGS', 'oauth:config:TOKEN_EXPIRY'],
    ['AUTHRIM_CONFIG', 'consent:ip_salt:tenant-a'],
    ['AUTHRIM_CONFIG', 'oauth:config:NEW_SECRET'],
    ['KV', 'consent:ip_salt:tenant-a:extra'],
    ['KV', 'consent:ip_salt:'],
    ['KV', 'x'.repeat(513)],
  ])('does not broaden ownership for %s / %s', (binding, key) => {
    expect(classifyLegacyKvKey(binding, key, context)).toEqual({ kind: 'unsupported' });
  });
});
