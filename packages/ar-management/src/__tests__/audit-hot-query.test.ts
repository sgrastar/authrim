import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantRuntimeProfilesFromEnv: vi.fn(async (env: Partial<Env>) => {
      const auditProfileId = (env as Record<string, unknown>).DEFAULT_AUDIT_PROFILE_ID;
      if (auditProfileId === 'builtin:audit:archive-only-logpush') {
        return {
          auditProfile: {
            id: 'builtin:audit:archive-only-logpush',
            kind: 'audit',
            label: 'Archive Only + Logpush',
            builtin: true,
            primary: null,
            archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
            sinks: [],
          },
        };
      }
      if (auditProfileId === 'custom:audit:postgres-primary') {
        return {
          auditProfile: {
            id: 'custom:audit:postgres-primary',
            kind: 'audit',
            label: 'Postgres Primary',
            builtin: false,
            primary: { type: 'postgres', connectionRef: 'audit-primary', dataset: 'event_log' },
            archive: null,
            sinks: [],
          },
        };
      }
      if (auditProfileId === 'custom:audit:mysql-primary') {
        return {
          auditProfile: {
            id: 'custom:audit:mysql-primary',
            kind: 'audit',
            label: 'MySQL Primary',
            builtin: false,
            primary: { type: 'mysql', connectionRef: 'audit-primary-mysql', dataset: 'event_log' },
            archive: null,
            sinks: [],
          },
        };
      }
      return {
        auditProfile: {
          id: 'builtin:audit:standard',
          kind: 'audit',
          label: 'Standard Audit',
          builtin: true,
          primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
          archive: null,
          sinks: [],
        },
      };
    }),
  };
});

import { getAuditHotQuerySupport } from '../audit-hot-query';

describe('getAuditHotQuerySupport', () => {
  it('supports D1-backed audit profiles', async () => {
    const support = await getAuditHotQuerySupport(
      { DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:standard' } as Env,
      'default'
    );

    expect(support).toEqual(
      expect.objectContaining({
        supported: true,
        status: 'supported',
        auditProfileId: 'builtin:audit:standard',
        context: expect.objectContaining({
          mode: 'unified',
          dialect: 'sqlite',
          createdAtUnit: 'milliseconds',
        }),
      })
    );
  });

  it('supports postgres-backed audit profiles when a Hyperdrive binding is available', async () => {
    const support = await getAuditHotQuerySupport(
      {
        DEFAULT_AUDIT_PROFILE_ID: 'custom:audit:postgres-primary',
        HYPERDRIVE_AUDIT_PRIMARY: {
          connectionString: 'postgres://audit:secret@example.com:5432/authrim',
        },
      } as unknown as Env,
      'default'
    );

    expect(support).toEqual(
      expect.objectContaining({
        supported: true,
        status: 'supported',
        auditProfileId: 'custom:audit:postgres-primary',
        context: expect.objectContaining({
          mode: 'unified',
          dialect: 'postgres',
          createdAtUnit: 'milliseconds',
        }),
      })
    );
  });

  it('marks external-primary profiles as pending runtime support when no binding is resolved', async () => {
    const support = await getAuditHotQuerySupport(
      { DEFAULT_AUDIT_PROFILE_ID: 'custom:audit:postgres-primary' } as Env,
      'default'
    );

    expect(support.supported).toBe(false);
    expect(support.status).toBe('pending_runtime_support');
    expect(support.auditProfileId).toBe('custom:audit:postgres-primary');
  });

  it('marks archive-only profiles as not supported', async () => {
    const support = await getAuditHotQuerySupport(
      { DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:archive-only-logpush' } as Env,
      'default'
    );

    expect(support.supported).toBe(false);
    expect(support.status).toBe('not_supported');
    expect(support.auditProfileId).toBe('builtin:audit:archive-only-logpush');
  });

  it('supports mysql-backed audit profiles when a Hyperdrive binding is available', async () => {
    const support = await getAuditHotQuerySupport(
      {
        DEFAULT_AUDIT_PROFILE_ID: 'custom:audit:mysql-primary',
        HYPERDRIVE_AUDIT_PRIMARY_MYSQL: {
          connectionString: 'mysql://audit:secret@example.com:3306/authrim',
          host: 'mysql.example.com',
          user: 'audit',
          password: 'secret',
          database: 'authrim',
          port: 3306,
        },
      } as unknown as Env,
      'default'
    );

    expect(support).toEqual(
      expect.objectContaining({
        supported: true,
        status: 'supported',
        auditProfileId: 'custom:audit:mysql-primary',
        context: expect.objectContaining({
          mode: 'unified',
          dialect: 'mysql',
          createdAtUnit: 'milliseconds',
        }),
      })
    );
  });
});
