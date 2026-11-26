/**
 * The certificate validation summary the provider list attaches to every configuration: which
 * date counts as "valid until", expiry flags, weak signature detection and unparsable input.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bodyOf,
  createAdapter,
  dig,
  harnessContext,
  providerRow,
} from './helpers/provider-handler-harness';
import {
  EC_P256_PEM,
  RSA_1024_SHA1_PEM,
  RSA_2048_LONG_VALIDITY_PEM,
  RSA_2048_MD5_PEM,
  RSA_2048_SHA256_PEM,
} from '../__fixtures__/certificates';

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({ adapter: null as ReturnType<typeof createAdapter> | null }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

import { handleListProviders } from '../providers';

async function summarise(config: Record<string, unknown>): Promise<unknown> {
  mocks.adapter?.query.mockResolvedValue([
    providerRow({ provider_type: 'saml_idp', config_json: JSON.stringify(config) }),
  ]);
  const response = await handleListProviders(harnessContext({}));
  return dig(await bodyOf<unknown>(response), 'providers', 0, 'config', 'certificateValidation');
}

const NOW = Date.parse('2030-01-01T00:00:00Z');
const SHORT_END = '2036-11-15T07:28:14.000Z';
const LONG_END = '2059-09-26T07:28:14.000Z';

beforeEach(() => {
  mocks.adapter = createAdapter();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('certificate validation summary', () => {
  it('is absent for a configuration without certificates', async () => {
    expect(await summarise({ entityId: 'x' })).toBeUndefined();
    expect(
      await summarise({ entityId: 'x', certificate: '   ', certificates: ['', '  '] })
    ).toBeUndefined();
  });

  it('describes a single current certificate', async () => {
    const summary = await summarise({ entityId: 'x', certificate: ` ${RSA_2048_SHA256_PEM} ` });

    expect(summary).toMatchObject({
      checkedAt: NOW,
      validUntil: SHORT_END,
      allExpired: false,
      hasExpired: false,
      hasWeakSignature: false,
    });
    expect(dig(summary, 'certificates')).toHaveLength(1);
    expect(String(dig(summary, 'certificates', 0, 'signatureAlgorithm'))).toMatch(/sha-?256/i);
    expect(dig(summary, 'certificates', 0)).toMatchObject({
      validTo: SHORT_END,
      expired: false,
      notYetValid: false,
    });
  });

  it('collects the primary and the additional certificates once each', async () => {
    const summary = await summarise({
      entityId: 'x',
      certificate: RSA_2048_SHA256_PEM,
      certificates: [RSA_2048_SHA256_PEM, `  ${EC_P256_PEM}  `, ''],
    });

    expect(dig(summary, 'certificates')).toHaveLength(2);
  });

  it('reports the earliest end date among the certificates that are still valid', async () => {
    const summary = await summarise({
      entityId: 'x',
      certificates: [RSA_2048_LONG_VALIDITY_PEM, RSA_2048_SHA256_PEM],
    });

    expect(dig(summary, 'validUntil')).toBe(SHORT_END);
    expect(dig(summary, 'allExpired')).toBe(false);
  });

  it('ignores expired certificates when choosing the date, but flags that one expired', async () => {
    vi.setSystemTime(Date.parse('2040-01-01T00:00:00Z'));

    const summary = await summarise({
      entityId: 'x',
      certificates: [RSA_2048_SHA256_PEM, RSA_2048_LONG_VALIDITY_PEM],
    });

    expect(dig(summary, 'validUntil')).toBe(LONG_END);
    expect(dig(summary, 'hasExpired')).toBe(true);
    expect(dig(summary, 'allExpired')).toBe(false);
    expect(dig(summary, 'certificates', 0, 'expired')).toBe(true);
    expect(dig(summary, 'certificates', 1, 'expired')).toBe(false);
  });

  it('reports the latest end date when every certificate has expired', async () => {
    vi.setSystemTime(Date.parse('2070-01-01T00:00:00Z'));

    const summary = await summarise({
      entityId: 'x',
      certificates: [RSA_2048_LONG_VALIDITY_PEM, RSA_2048_SHA256_PEM],
    });

    expect(dig(summary, 'validUntil')).toBe(LONG_END);
    expect(dig(summary, 'allExpired')).toBe(true);
    expect(dig(summary, 'hasExpired')).toBe(true);
  });

  it('marks a certificate that is not valid yet', async () => {
    vi.setSystemTime(Date.parse('2020-01-01T00:00:00Z'));

    const summary = await summarise({ entityId: 'x', certificate: RSA_2048_SHA256_PEM });

    expect(dig(summary, 'certificates', 0, 'notYetValid')).toBe(true);
    expect(dig(summary, 'certificates', 0, 'expired')).toBe(false);
  });

  it.each([
    ['SHA-1', RSA_1024_SHA1_PEM],
    ['MD5', RSA_2048_MD5_PEM],
  ])('flags a %s signature as weak', async (_label, certificate) => {
    const summary = await summarise({
      entityId: 'x',
      certificates: [RSA_2048_SHA256_PEM, certificate],
    });

    expect(dig(summary, 'hasWeakSignature')).toBe(true);
  });

  it('does not flag a modern signature as weak', async () => {
    expect(
      dig(
        await summarise({ entityId: 'x', certificates: [EC_P256_PEM, RSA_2048_LONG_VALIDITY_PEM] }),
        'hasWeakSignature'
      )
    ).toBe(false);
  });

  it('reports an unparsable certificate as a warning without failing the others', async () => {
    const summary = await summarise({
      entityId: 'x',
      certificates: [
        '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
        RSA_2048_SHA256_PEM,
      ],
    });

    expect(dig(summary, 'certificates', 0, 'expired')).toBe(false);
    expect(dig(summary, 'certificates', 0, 'notYetValid')).toBe(false);
    const warnings = dig(summary, 'certificates', 0, 'warnings') as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Certificate could not be parsed: .+/);
    expect(dig(summary, 'validUntil')).toBe(SHORT_END);
    expect(dig(summary, 'warnings')).toContain(warnings[0]);
  });

  it('is never all-expired when no certificate could be read', async () => {
    const summary = await summarise({ entityId: 'x', certificate: 'garbage' });

    expect(dig(summary, 'allExpired')).toBe(false);
    expect(dig(summary, 'validUntil')).toBeUndefined();
  });
});
