import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS, hasAdminPermission } from '../admin-user';

describe('operation-level Admin permissions', () => {
  it('accepts the exact or wildcard user suspension permission', () => {
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.USERS_SUSPEND], ADMIN_PERMISSIONS.USERS_SUSPEND)
    ).toBe(true);
    expect(hasAdminPermission([ADMIN_PERMISSIONS.USERS_ALL], ADMIN_PERMISSIONS.USERS_SUSPEND)).toBe(
      true
    );
  });

  it('keeps coarse users:write as an explicit compatibility ceiling', () => {
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.USERS_WRITE], ADMIN_PERMISSIONS.USERS_SUSPEND)
    ).toBe(true);
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.USERS_READ], ADMIN_PERMISSIONS.USERS_SUSPEND)
    ).toBe(false);
  });

  it('keeps coarse settings:write as a ceiling for granular settings mutations', () => {
    for (const required of [
      ADMIN_PERMISSIONS.SETTINGS_ASSURANCE_UPDATE,
      ADMIN_PERMISSIONS.SETTINGS_SECURITY_UPDATE,
      ADMIN_PERMISSIONS.SETTINGS_TOKEN_EXCHANGE_UPDATE,
      ADMIN_PERMISSIONS.SETTINGS_OAUTH_UPDATE,
      ADMIN_PERMISSIONS.SETTINGS_SESSION_UPDATE,
      ADMIN_PERMISSIONS.SETTINGS_LOGIN_UI_UPDATE,
    ]) {
      expect(hasAdminPermission([ADMIN_PERMISSIONS.SETTINGS_WRITE], required)).toBe(true);
      expect(hasAdminPermission([ADMIN_PERMISSIONS.SETTINGS_READ], required)).toBe(false);
    }
  });

  it('maps legacy client write to the operation-specific compatibility ceilings', () => {
    for (const required of [
      ADMIN_PERMISSIONS.CLIENTS_CREATE,
      ADMIN_PERMISSIONS.CLIENTS_UPDATE,
      ADMIN_PERMISSIONS.CLIENTS_SECRET_ROTATE,
    ]) {
      expect(hasAdminPermission([ADMIN_PERMISSIONS.CLIENTS_WRITE], required)).toBe(true);
      expect(hasAdminPermission([ADMIN_PERMISSIONS.CLIENTS_READ], required)).toBe(false);
    }
  });

  it('separates policy simulation and Flow lifecycle permissions', () => {
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.ROLES_READ], ADMIN_PERMISSIONS.POLICY_SIMULATE)
    ).toBe(true);
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.SETTINGS_READ], ADMIN_PERMISSIONS.FLOWS_VALIDATE)
    ).toBe(true);
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.SETTINGS_READ], ADMIN_PERMISSIONS.FLOWS_PUBLISH)
    ).toBe(false);
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.SETTINGS_WRITE], ADMIN_PERMISSIONS.FLOWS_PUBLISH)
    ).toBe(true);
  });
});
