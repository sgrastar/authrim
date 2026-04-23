import { describe, expect, it } from 'vitest';
import {
  INFRASTRUCTURE_DEFAULTS,
  INFRASTRUCTURE_SETTINGS_META,
} from '../infrastructure';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
} from '../../runtime-profile';

describe('INFRASTRUCTURE_SETTINGS_META', () => {
  it('exposes runtime profile defaults as platform-visible pointers', () => {
    expect(INFRASTRUCTURE_SETTINGS_META['infra.default_storage_profile_id'].visibility).toBe(
      'admin'
    );
    expect(INFRASTRUCTURE_SETTINGS_META['infra.default_storage_profile_id'].default).toBe(
      DEFAULT_STORAGE_PROFILE_ID
    );
    expect(INFRASTRUCTURE_SETTINGS_META['infra.default_audit_profile_id'].default).toBe(
      DEFAULT_AUDIT_PROFILE_ID
    );
    expect(INFRASTRUCTURE_SETTINGS_META['infra.default_residency_profile_id'].default).toBe(
      DEFAULT_RESIDENCY_PROFILE_ID
    );

    expect(INFRASTRUCTURE_DEFAULTS['infra.default_storage_profile_id']).toBe(
      DEFAULT_STORAGE_PROFILE_ID
    );
    expect(INFRASTRUCTURE_DEFAULTS['infra.default_audit_profile_id']).toBe(
      DEFAULT_AUDIT_PROFILE_ID
    );
    expect(INFRASTRUCTURE_DEFAULTS['infra.default_residency_profile_id']).toBe(
      DEFAULT_RESIDENCY_PROFILE_ID
    );
  });
});
