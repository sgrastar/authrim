/**
 * Which settings the bulk apply may give to a tenant. The decision is made from the reviewed
 * handling of every setting (the tenant backup inventory) and two explicit lists; a setting that
 * has not been reviewed is refused.
 */
import { describe, expect, it } from 'vitest';
import { ALL_CATEGORY_META, CATEGORY_SCOPE_CONFIG } from '../../types/settings/catalog';
import {
  BULK_APPLY_EXCLUDED_KEYS,
  BULK_APPLY_SHARED_REFERENCE_KEYS,
  bulkApplyCategoryVerdict,
  bulkApplyKeyVerdict,
} from '../settings-bulk-apply-policy';
import { TENANT_SETTING_FIELD_POLICIES } from '../tenant-portability/settings-field-registry';

const handlingOf = new Map(TENANT_SETTING_FIELD_POLICIES.map((p) => [p.key, p.handling]));

function everySetting() {
  return Object.entries(ALL_CATEGORY_META).flatMap(([category, meta]) =>
    Object.keys(meta.settings).map((key) => ({ category, key }))
  );
}

describe('the bulk apply policy', () => {
  it.each([
    ['a lifetime', 'session', 'session.default_ttl'],
    ['a switch', 'oauth', 'oauth.refresh_token_rotation'],
    ['a bound', 'limits', 'limits.max_custom_claims'],
    ['an enum', 'oauth', 'oauth.error_response_format'],
    ['a feature flag', 'feature-flags', 'feature.enable_abac'],
    [
      'a sign-in method switch',
      'authentication-methods',
      'authentication-methods.passkey.login_enabled',
    ],
    ['a color', 'login-ui', 'login-ui.accent_color'],
    [
      'the default Mapping Set, a reference to a record every tenant shares',
      'identity-mapping',
      'identity_mapping.oidc_default_set_id',
    ],
  ])('allows %s', (_name, category, key) => {
    expect(bulkApplyKeyVerdict(category, key)).toEqual({ ok: true });
  });

  it.each([
    ['a URL', 'tenant', 'tenant.ui_base_url', 'tenant_specific_url'],
    ['a list of origins', 'security', 'security.trusted_redirect_origins', 'tenant_specific_url'],
    ['a domain list', 'tenant', 'tenant.allowed_domains', 'tenant_specific_url'],
    ['an image of the tenant', 'login-ui', 'login-ui.logo_url', 'tenant_specific_url'],
    ['a UI path', 'tenant', 'tenant.ui_login_path', 'tenant_ui_routing'],
    [
      'the account page path',
      'self-service',
      'self-service.account_page_path',
      'tenant_ui_routing',
    ],
    ['the default access token target', 'dcr', 'dcr.default_resource', 'tenant_identifier'],
    ['the tenant’s brand name', 'login-ui', 'login-ui.brand_name', 'tenant_brand_text'],
    [
      'a provider list',
      'external-idp',
      'external_idp.jit_allowed_provider_ids',
      'tenant_specific_reference',
    ],
    [
      'a role reference',
      'external-idp',
      'external_idp.jit_default_role_id',
      'tenant_specific_reference',
    ],
    ['a profile reference', 'tenant', 'tenant.audit_profile_id', 'tenant_specific_reference'],
    ['CSS', 'login-ui', 'login-ui.custom_css', 'structured_value'],
    [
      'a policy document',
      'authentication-methods',
      'authentication-methods.totp.requirement_policy',
      'structured_value',
    ],
    [
      'a storage binding',
      'diagnostic-logging',
      'diagnostic-logging.r2_bucket_binding',
      'environment_mapping',
    ],
    [
      'a backup destination',
      'dr-backup',
      'dr-backup.storage_destination_id',
      'environment_mapping',
    ],
    ['a setup-time setting', 'tenant', 'tenant.user_id_format', 'setting_setup_time_only'],
    ['a publishing record', 'login-ui', 'login-ui.published_version', 'setting_setup_time_only'],
    [
      'a platform-only setting of a tenant category',
      'rate-limit',
      'rate_limit.strict',
      'setting_not_at_tenant_scope',
    ],
    ['a setting that does not exist', 'session', 'session.nothing', 'unknown_setting'],
    ['a category that does not exist', 'nothing', 'x.y', 'unknown_category'],
    [
      'a platform-only category',
      'infrastructure',
      'infrastructure.anything',
      'category_not_at_tenant_scope',
    ],
    ['an app-only category', 'client', 'client.anything', 'category_not_at_tenant_scope'],
    [
      'the limits of the bulk apply itself',
      'bulk-apply',
      'bulk_apply.max_tenants_per_request',
      'category_not_at_tenant_scope',
    ],
  ])('refuses %s, with a reason', (_name, category, key, reason) => {
    const verdict = bulkApplyKeyVerdict(category, key);
    expect(verdict).toMatchObject({ ok: false, reason });
    expect((verdict as { explanation: string }).explanation.length).toBeGreaterThan(10);
  });

  it('refuses a category that cannot be set for a tenant, before looking at a key', () => {
    expect(bulkApplyCategoryVerdict('session')).toEqual({ ok: true });
    for (const category of ['infrastructure', 'encryption', 'cache', 'client', 'bulk-apply']) {
      expect(bulkApplyCategoryVerdict(category), category).toMatchObject({ ok: false });
    }
  });

  it('does not take a name from the prototype for a category or a key', () => {
    expect(bulkApplyKeyVerdict('constructor', 'x')).toMatchObject({
      ok: false,
      reason: 'unknown_category',
    });
    expect(bulkApplyKeyVerdict('session', 'constructor')).toMatchObject({
      ok: false,
      reason: 'unknown_setting',
    });
  });

  it('has reviewed every setting there is: none is refused for want of a review', () => {
    const unreviewed = everySetting().filter(
      ({ category, key }) =>
        (bulkApplyKeyVerdict(category, key) as { reason?: string }).reason ===
        'setting_not_reviewed'
    );
    expect(unreviewed).toEqual([]);
  });

  it('refuses a setting that nobody has classified, rather than letting it through', () => {
    const settings = ALL_CATEGORY_META.session.settings as Record<string, unknown>;
    settings['session.new_unreviewed'] = {
      key: 'session.new_unreviewed',
      type: 'boolean',
      default: false,
      label: 'x',
      description: 'x',
    };
    try {
      expect(bulkApplyKeyVerdict('session', 'session.new_unreviewed')).toMatchObject({
        ok: false,
        reason: 'setting_not_reviewed',
      });
    } finally {
      delete settings['session.new_unreviewed'];
    }
  });

  it('lets through a tenant-level setting only when its reviewed handling is a plain value, or it is a shared reference', () => {
    for (const { category, key } of everySetting()) {
      if (
        !CATEGORY_SCOPE_CONFIG[
          category as keyof typeof CATEGORY_SCOPE_CONFIG
        ].allowedScopes.includes('tenant')
      )
        continue;
      const verdict = bulkApplyKeyVerdict(category, key);
      if (!verdict.ok) continue;
      const handling = handlingOf.get(key);
      expect(
        handling === 'value' || BULK_APPLY_SHARED_REFERENCE_KEYS.has(key),
        `${key} is ${handling}`
      ).toBe(true);
      expect(Object.hasOwn(BULK_APPLY_EXCLUDED_KEYS, key), key).toBe(false);
    }
  });

  it('keeps its explicit lists to settings that exist and whose handling is what the list says', () => {
    const known = new Set(everySetting().map(({ key }) => key));
    for (const key of Object.keys(BULK_APPLY_EXCLUDED_KEYS)) {
      expect(known.has(key), key).toBe(true);
      // Listed because the reviewed handling alone would let it through.
      expect(handlingOf.get(key), key).toBe('value');
    }
    for (const key of BULK_APPLY_SHARED_REFERENCE_KEYS) {
      expect(known.has(key), key).toBe(true);
      expect(handlingOf.get(key), key).toBe('logical_reference');
    }
  });
});
