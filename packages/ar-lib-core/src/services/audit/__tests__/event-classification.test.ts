import { describe, expect, it } from 'vitest';
import { classifyAuditEvent, resolveAuditEventFailureBehavior } from '../event-classification';

describe('audit event classification', () => {
  it('classifies login audit as fail-open best-effort', () => {
    expect(classifyAuditEvent('login.success')).toMatchObject({
      category: 'login',
      behavior: 'fail_open_best_effort',
    });
    expect(classifyAuditEvent('auth.login.passwordless')).toMatchObject({
      category: 'login',
      behavior: 'fail_open_best_effort',
    });
    expect(classifyAuditEvent('user.login')).toMatchObject({
      category: 'login',
      behavior: 'fail_open_best_effort',
    });
  });

  it('classifies token audit as fail-open best-effort', () => {
    expect(classifyAuditEvent('token.issued')).toMatchObject({
      category: 'token',
      behavior: 'fail_open_best_effort',
    });
    expect(classifyAuditEvent('refresh_token.rotated')).toMatchObject({
      category: 'token',
      behavior: 'fail_open_best_effort',
    });
    expect(classifyAuditEvent('userinfo.success')).toMatchObject({
      category: 'token',
      behavior: 'fail_open_best_effort',
    });
  });

  it('classifies user activity audit as fail-open best-effort', () => {
    expect(classifyAuditEvent('user.activity.viewed')).toMatchObject({
      category: 'user_activity',
      behavior: 'fail_open_best_effort',
    });
  });

  it('keeps user administrative changes fail-closed', () => {
    expect(classifyAuditEvent('user.suspend')).toMatchObject({
      category: 'admin_user',
      behavior: 'fail_closed_or_strong_retry',
    });
    expect(classifyAuditEvent('user.pii_purge_started')).toMatchObject({
      category: 'admin_user',
      behavior: 'fail_closed_or_strong_retry',
    });
  });

  it('classifies privileged control-plane changes as fail-closed or strong retry', () => {
    expect(classifyAuditEvent('signing_keys.rotate')).toMatchObject({
      category: 'signing_key',
      behavior: 'fail_closed_or_strong_retry',
    });
    expect(classifyAuditEvent('admin_user.create')).toMatchObject({
      category: 'admin_user',
      behavior: 'fail_closed_or_strong_retry',
    });
    expect(classifyAuditEvent('tenant_database.provision.requested')).toMatchObject({
      category: 'database',
      behavior: 'fail_closed_or_strong_retry',
    });
    expect(classifyAuditEvent('storage_destination.credential.update')).toMatchObject({
      category: 'data_governance',
      behavior: 'fail_closed_or_strong_retry',
    });
    expect(classifyAuditEvent('refresh_token.theft_detected')).toMatchObject({
      category: 'security_setting',
      behavior: 'fail_closed_or_strong_retry',
    });
  });

  it('normalizes common separators and defaults unknown events to strong delivery', () => {
    expect(classifyAuditEvent('TOKEN:issued')).toMatchObject({
      category: 'token',
      behavior: 'fail_open_best_effort',
    });
    expect(classifyAuditEvent('new_sensitive_surface.changed')).toMatchObject({
      category: 'other',
      behavior: 'fail_closed_or_strong_retry',
    });
  });

  it('supports fail_closed_all mode for stricter audit profiles', () => {
    expect(resolveAuditEventFailureBehavior('login.success', 'fail_closed_all')).toMatchObject({
      category: 'login',
      behavior: 'fail_closed_or_strong_retry',
    });
    expect(resolveAuditEventFailureBehavior('login.success', 'event_class')).toMatchObject({
      category: 'login',
      behavior: 'fail_open_best_effort',
    });
  });
});
