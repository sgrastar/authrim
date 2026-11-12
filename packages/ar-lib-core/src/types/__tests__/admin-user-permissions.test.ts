import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  isExactMatchOnlyAdminPermission,
} from '../admin-user';
import { ADMIN_ROLE_DEFINITIONS } from '../../constants/admin-roles';

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

  it('lets users:read include the status-only read, never the other way round', () => {
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.USERS_READ], ADMIN_PERMISSIONS.USERS_STATUS_READ)
    ).toBe(true);
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.USERS_ALL], ADMIN_PERMISSIONS.USERS_STATUS_READ)
    ).toBe(true);
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.USERS_STATUS_READ], ADMIN_PERMISSIONS.USERS_READ)
    ).toBe(false);
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.USERS_WRITE], ADMIN_PERMISSIONS.USERS_STATUS_READ)
    ).toBe(false);
    expect(
      hasAdminPermission([ADMIN_PERMISSIONS.SESSIONS_READ], ADMIN_PERMISSIONS.USERS_STATUS_READ)
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

describe('step-up exemption permissions', () => {
  const exempt = 'admin:step_up_exempt:tenant.delete';

  it.each([['*'], ['admin:*'], ['admin:step_up_exempt:*']])(
    'is not granted by the wildcard %s',
    (wildcard) => {
      expect(hasAdminPermission([wildcard], exempt)).toBe(false);
    }
  );

  it('is granted by its exact name only', () => {
    expect(hasAdminPermission([exempt], exempt)).toBe(true);
    expect(hasAdminPermission([exempt], 'admin:step_up_exempt:dr.restore')).toBe(false);
  });
});

describe('break-glass permissions', () => {
  const request = ADMIN_PERMISSIONS.SUPPORT_OPS_BREAK_GLASS_REQUEST;
  const reveal = ADMIN_PERMISSIONS.SUPPORT_OPS_BREAK_GLASS_REVEAL;

  it.each([['*'], ['admin:*'], ['admin:support_ops:*'], ['admin:support_ops:break_glass:*']])(
    'is not granted by the wildcard %s',
    (wildcard) => {
      expect(hasAdminPermission([wildcard], request)).toBe(false);
      expect(hasAdminPermission([wildcard], reveal)).toBe(false);
    }
  );

  it('is granted by its exact name only', () => {
    expect(hasAdminPermission([request], request)).toBe(true);
    expect(hasAdminPermission([request], reveal)).toBe(false);
    expect(hasAdminPermission([reveal], request)).toBe(false);
  });

  it('leaves the other Support Ops permissions to the wildcards', () => {
    expect(
      hasAdminPermission(['admin:support_ops:*'], ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_APPROVE)
    ).toBe(true);
    expect(hasAdminPermission(['*'], ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_APPROVE)).toBe(true);
  });
});

describe('tenant provisioning and deletion permissions', () => {
  const provision = ADMIN_PERMISSIONS.TENANT_PROVISION;
  const remove = ADMIN_PERMISSIONS.TENANT_DELETE;

  it('are named in the tenants namespace and distinct from the lifecycle permissions', () => {
    expect(provision).toBe('admin:tenants:provision');
    expect(remove).toBe('admin:tenants:delete');
  });

  it.each(['*', 'admin:*', 'admin:tenants:*'])('are carried by the wildcard %s', (wildcard) => {
    expect(hasAdminPermission([wildcard], provision)).toBe(true);
    expect(hasAdminPermission([wildcard], remove)).toBe(true);
  });

  it('are held by their own name, and neither implies the other nor the lifecycle permissions', () => {
    expect(hasAdminPermission([provision], provision)).toBe(true);
    expect(hasAdminPermission([provision], remove)).toBe(false);
    expect(hasAdminPermission([remove], provision)).toBe(false);
    expect(
      hasAdminPermission([provision, remove], ADMIN_PERMISSIONS.TENANT_LIFECYCLE_STANDARD)
    ).toBe(false);
    expect(hasAdminPermission([ADMIN_PERMISSIONS.SETTINGS_WRITE], provision)).toBe(false);
    expect(hasAdminPermission([ADMIN_PERMISSIONS.TENANT_LIFECYCLE_STANDARD], remove)).toBe(false);
  });
});

describe('admin invitation code handoff permission', () => {
  const handoff = ADMIN_PERMISSIONS.ADMIN_INVITATION_CODE_HANDOFF;

  it('is named in the admin invitations namespace and held by exact name only', () => {
    expect(handoff).toBe('admin:admin_invitations:code_handoff');
    expect(isExactMatchOnlyAdminPermission(handoff)).toBe(true);
    expect(hasAdminPermission([handoff], handoff)).toBe(true);
  });

  it.each([
    ['*'],
    ['admin:*'],
    ['admin:admin_invitations:*'],
    ['admin:admin_users:*'],
    ['admin:admin_users:write'],
    ['admin:admin_roles:write'],
  ])('is not carried by %s', (permission) => {
    expect(hasAdminPermission([permission], handoff)).toBe(false);
  });

  it('is in no built-in role', () => {
    for (const role of ADMIN_ROLE_DEFINITIONS) {
      expect(role.permissions, role.name).not.toContain(handoff);
      expect(hasAdminPermission([...role.permissions], handoff), role.name).toBe(false);
    }
  });
});
