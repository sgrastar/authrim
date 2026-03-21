import { describe, expect, it } from 'vitest';
import { buildCliCapabilityRows } from '../cli/capability-summary.js';
import type { SetupCapabilityDiagnostics } from '../core/cloudflare.js';

function createDiagnostics(
  overrides: Partial<SetupCapabilityDiagnostics> = {}
): SetupCapabilityDiagnostics {
  return {
    wranglerInstalled: true,
    loggedIn: true,
    tokenAvailable: true,
    workersSubdomainAvailable: true,
    zoneReadAvailable: true,
    accessibleZoneCount: 1,
    dnsReadAvailable: true,
    pagesReadAvailable: true,
    ...overrides,
  };
}

describe('buildCliCapabilityRows', () => {
  it('builds Japanese summary rows with OK states', () => {
    const summary = buildCliCapabilityRows(createDiagnostics(), 'ja');

    expect(summary.title).toBe('利用可否の目安');
    expect(summary.rows).toHaveLength(3);
    expect(summary.rows[0]).toMatchObject({
      label: 'Workers デプロイ',
      status: 'ok',
    });
  });

  it('uses review labels and descriptions for uncertain zone and Pages access', () => {
    const summary = buildCliCapabilityRows(
      createDiagnostics({
        zoneReadAvailable: false,
        pagesReadAvailable: false,
      }),
      'en'
    );

    expect(summary.rows[1]).toMatchObject({
      label: 'Custom domain',
      status: 'review',
    });
    expect(summary.reviewLabel).toBe('Review');
    expect(summary.rows[1]?.description).toContain('needs review');
    expect(summary.rows[2]?.description).toContain('needs review');
  });

  it('keeps explicit NG when no accessible zone exists', () => {
    const summary = buildCliCapabilityRows(
      createDiagnostics({
        zoneReadAvailable: true,
        accessibleZoneCount: 0,
        dnsReadAvailable: false,
      }),
      'ja'
    );

    expect(summary.rows[1]).toMatchObject({
      label: 'カスタムドメイン',
      status: 'ng',
    });
    expect(summary.rows[1]?.description).toContain('Cloudflare Zone が見つからない');
  });

  it('localizes the review label for supported non-English locales', () => {
    const summary = buildCliCapabilityRows(
      createDiagnostics({
        zoneReadAvailable: false,
      }),
      'ko'
    );

    expect(summary.reviewLabel).toBe('확인 필요');
  });
});
