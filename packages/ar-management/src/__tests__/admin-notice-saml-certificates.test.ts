import { describe, expect, it, vi } from 'vitest';
import type { AdminNoticeRepository, DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  open: [] as string[],
  resolved: [] as string[],
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class FakeNotices {
    async create(input: Record<string, unknown>) {
      mocks.created.push(input);
      return input;
    }
    async listOpenDeduplicationKeys(tenantId: string) {
      return mocks.open.filter((key) => key.startsWith(`saml-cert:${tenantId}:`));
    }
    async resolveByDeduplicationKey(key: string) {
      mocks.resolved.push(key);
      return true;
    }
  }
  return {
    ...actual,
    AdminNoticeRepository: FakeNotices,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
  };
});

import {
  certificateLevel,
  findSamlCertificateProblems,
  certificateCoverageEnd,
  processScheduledSamlCertificateNotices,
  syncSamlCertificateNotices,
} from '../admin-notice-saml-certificates';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 24);
const config = (...ends: Array<string | undefined>) =>
  JSON.stringify({ certificateValidation: { certificates: ends.map((validTo) => ({ validTo })) } });
const spans = (...items: Array<[string | undefined, string]>) =>
  JSON.stringify({
    certificateValidation: {
      certificates: items.map(([validFrom, validTo]) => ({ validFrom, validTo })),
    },
  });
const row = (id: string, json: string, enabled = 1) => ({
  id,
  name: `Provider ${id}`,
  provider_type: 'saml_idp',
  config_json: json,
  enabled,
});
const iso = (days: number) => new Date(NOW + days * DAY).toISOString();

describe('SAML certificate notices', () => {
  it('reads the end of the coverage and ignores what it cannot read', () => {
    expect(certificateCoverageEnd(config(iso(5), iso(90)), NOW)).toBe(NOW + 90 * DAY);
    expect(certificateCoverageEnd(config(undefined, 'not a date'), NOW)).toBeNull();
    expect(certificateCoverageEnd('{', NOW)).toBeNull();
    expect(certificateCoverageEnd('{}', NOW)).toBeNull();
  });

  it('follows certificates that overlap or touch, and stops at a gap', () => {
    // Replacement already valid: coverage runs to its end.
    expect(certificateCoverageEnd(spans([iso(-30), iso(5)], [iso(-1), iso(200)]), NOW)).toBe(
      NOW + 200 * DAY
    );
    // Replacement starts after the current one ends: the gap shows as the current end.
    expect(certificateCoverageEnd(spans([iso(-30), iso(-1)], [iso(7), iso(365)]), NOW)).toBe(
      NOW - DAY
    );
    expect(certificateCoverageEnd(spans([iso(-30), iso(3)], [iso(7), iso(365)]), NOW)).toBe(
      NOW + 3 * DAY
    );
  });

  it('levels by the time left', () => {
    expect(certificateLevel(NOW - 1, NOW)).toBe('expired');
    expect(certificateLevel(NOW, NOW)).toBe('expired');
    expect(certificateLevel(NOW + 14 * DAY, NOW)).toBe('high');
    expect(certificateLevel(NOW + 15 * DAY, NOW)).toBe('caution');
    expect(certificateLevel(NOW + 30 * DAY, NOW)).toBe('caution');
    expect(certificateLevel(NOW + 31 * DAY, NOW)).toBeNull();
  });

  it('keeps a provider with a valid rollover certificate quiet', () => {
    const problems = findSamlCertificateProblems(
      [
        row('a', config(iso(-3))),
        row('b', config(iso(-3), iso(200))),
        row('c', config(iso(20))),
        row('d', config()),
      ],
      NOW
    );
    expect(problems.map((p) => [p.providerId, p.level])).toEqual([
      ['a', 'expired'],
      ['c', 'caution'],
    ]);
  });

  it('counts a provider the metadata sync switched off, not one an administrator did', () => {
    const suspended = JSON.stringify({
      metadataRefreshPolicy: { suspendedByMetadataSync: true },
      certificateValidation: { certificates: [{ validTo: iso(-2) }] },
    });
    const problems = findSamlCertificateProblems(
      [row('s', suspended, 0), row('off', config(iso(-2)), 0), row('on', config(iso(-2)), 1)],
      NOW
    );
    expect(problems.map((p) => p.providerId)).toEqual(['s', 'on']);
  });

  it('raises each problem with a keyed notice and resolves what is no longer due', async () => {
    mocks.created = [];
    mocks.resolved = [];
    mocks.open = [
      'saml-cert:t1:a:caution:2026-12-04',
      'saml-cert:t1:gone:high:2026-12-04',
      'saml-cert:t1:a:high:2026-12-04',
      'saml-cert:t1:a:high:2026-12-01',
    ];
    const problems = findSamlCertificateProblems([row('a', config(iso(10)))], NOW);
    const result = await syncSamlCertificateNotices(
      new (await import('@authrim/ar-lib-core')).AdminNoticeRepository({} as DatabaseAdapter),
      't1',
      problems,
      NOW
    );
    expect(result).toEqual({ raised: 1, resolved: 3 });
    expect(mocks.created[0]).toMatchObject({
      scope_type: 'tenant',
      tenant_id: 't1',
      severity: 'high',
      message_key: 'saml_certificate_expiring',
      deduplication_key: 'saml-cert:t1:a:high:2026-12-04',
      required_permission: 'admin:saml_providers:read',
    });
    expect(mocks.resolved.sort()).toEqual([
      'saml-cert:t1:a:caution:2026-12-04',
      'saml-cert:t1:a:high:2026-12-01',
      'saml-cert:t1:gone:high:2026-12-04',
    ]);
  });

  it('leaves a tenant alone when its providers cannot be read', async () => {
    mocks.created = [];
    mocks.resolved = [];
    mocks.open = ['saml-cert:t1:a:high:2026-12-04'];
    const log = { info: vi.fn(), warn: vi.fn() };
    const failing = {
      query: async () => {
        throw new Error('db down');
      },
    } as unknown as DatabaseAdapter;
    const working = {
      query: async () => [row('b', config(iso(-1)))],
    } as unknown as DatabaseAdapter;
    await processScheduledSamlCertificateNotices(
      {} as Env,
      [
        { tenantId: 't1', adapters: [{ adapter: failing, bindingRef: 'x' }] },
        { tenantId: 't2', adapters: [{ adapter: working, bindingRef: 'y' }] },
      ],
      log,
      NOW
    );
    expect(mocks.resolved).not.toContain('saml-cert:t1:a:high:2026-12-04');
    expect(mocks.created).toHaveLength(1);
    expect(mocks.created[0]).toMatchObject({
      tenant_id: 't2',
      severity: 'high',
      message_key: 'saml_certificate_expired',
    });
    expect(log.warn).toHaveBeenCalled();
  });
});

export type { AdminNoticeRepository };
