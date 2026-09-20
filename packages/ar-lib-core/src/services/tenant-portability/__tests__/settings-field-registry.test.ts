import { describe, expect, it } from 'vitest';
import { ALL_CATEGORY_META } from '../../../types/settings';
import {
  checkTenantSettingFieldCoverage,
  TENANT_SETTING_FIELD_POLICIES,
} from '../settings-field-registry';

const actual = Object.entries(ALL_CATEGORY_META).flatMap(([category, meta]) =>
  Object.values(meta.settings).map(({ key, type }) => ({ category, key, type }))
);

describe('settings field portability coverage', () => {
  it('classifies every registered setting with its exact category and type', () => {
    expect(checkTenantSettingFieldCoverage(actual)).toEqual({
      unclassified: [],
      stale: [],
      duplicates: [],
      changedShape: [],
    });
  });

  it('requires review even for a new boolean field', () => {
    expect(
      checkTenantSettingFieldCoverage([
        ...actual,
        { category: 'security', key: 'security.new_guard', type: 'boolean' },
      ]).unclassified
    ).toEqual(['security.new_guard']);
  });

  it('detects removed fields, moved categories and type changes', () => {
    const [field, second, ...rest] = actual;
    const result = checkTenantSettingFieldCoverage([
      { ...field, category: 'unreviewed-category', type: 'json' },
      ...rest,
    ]);
    expect(result.changedShape).toEqual([field.key]);
    expect(result.stale).toEqual([second.key]);
  });

  it('rejects duplicate definitions and duplicate policy declarations', () => {
    expect(checkTenantSettingFieldCoverage([...actual, actual[0]]).duplicates).toEqual([
      actual[0].key,
    ]);
    expect(
      checkTenantSettingFieldCoverage(actual, [
        ...TENANT_SETTING_FIELD_POLICIES,
        TENANT_SETTING_FIELD_POLICIES[0],
      ]).duplicates
    ).toEqual([TENANT_SETTING_FIELD_POLICIES[0].key]);
  });

  it.each([
    ['tokens.access_token_signing_key_id', 'key_reference'],
    ['tenant.audit_profile_id', 'logical_reference'],
    ['login-entry.app_login_client_id', 'logical_reference'],
    ['dr-backup.storage_destination_id', 'environment_mapping'],
    ['diagnostic-logging.r2_bucket_binding', 'environment_mapping'],
    ['login-ui.logo_url', 'url_or_asset'],
    ['login-ui.published_snapshot', 'structured'],
    ['login-ui.custom_css', 'structured'],
    ['login-ui.account_page_published', 'structured'],
    ['authentication-methods.totp.requirement_policy', 'structured'],
    ['diagnostic-logging.storage_mode.by_client', 'structured'],
  ])('requires specialized handling for %s', (key, handling) => {
    expect(TENANT_SETTING_FIELD_POLICIES.find((policy) => policy.key === key)?.handling).toBe(
      handling
    );
  });
});
