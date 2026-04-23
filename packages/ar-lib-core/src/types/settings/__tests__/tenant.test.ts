import { describe, expect, it } from 'vitest';
import { TENANT_DEFAULTS, TENANT_SETTINGS_META } from '../tenant';

describe('TENANT_SETTINGS_META', () => {
  it('marks tenant UI settings as page-visible', () => {
    expect(TENANT_SETTINGS_META['tenant.ui_base_url'].visibility).toBe('page');
    expect(TENANT_SETTINGS_META['tenant.ui_login_path'].visibility).toBe('page');
    expect(TENANT_SETTINGS_META['tenant.ui_consent_path'].visibility).toBe('page');
    expect(TENANT_SETTINGS_META['tenant.ui_reauth_path'].visibility).toBe('page');
    expect(TENANT_SETTINGS_META['tenant.ui_error_path'].visibility).toBe('page');
  });

  it('keeps runtime profile overrides as admin-visible pointers', () => {
    expect(TENANT_SETTINGS_META['tenant.storage_profile_id'].visibility).toBe('admin');
    expect(TENANT_SETTINGS_META['tenant.audit_profile_id'].visibility).toBe('admin');
    expect(TENANT_SETTINGS_META['tenant.residency_profile_id'].visibility).toBe('admin');

    expect(TENANT_DEFAULTS['tenant.storage_profile_id']).toBe('');
    expect(TENANT_DEFAULTS['tenant.audit_profile_id']).toBe('');
    expect(TENANT_DEFAULTS['tenant.residency_profile_id']).toBe('');
  });
});
