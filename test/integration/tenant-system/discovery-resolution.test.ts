import { describe, expect, it } from 'vitest';
import { tenantSystemProfiles } from '../../fixtures/tenant-system/profiles';
import {
  applyLoginEntryProfile,
  buildEnvForTopology,
  createTenantSystemDiscoveryApp,
  loadMatrixCsv,
  makeCommonHost,
  postDiscoveryRequest,
  seedTenantDataset,
} from './helpers';

interface DiscoveryInputDataMatrixRow {
  case_id: string;
  mode: 'email' | 'tenant_code' | 'tenant_slug' | 'invite_token' | 'app_hint';
  data_condition: string;
  profiles: string;
  expect: string;
}

describe('tenant-system discovery resolution matrix', () => {
  const rows = loadMatrixCsv<DiscoveryInputDataMatrixRow>(
    'tenant-system-discovery-input-data-matrix.csv'
  );

  it.each(rows)('$case_id has discovery input coverage metadata', (row) => {
    expect(['email', 'tenant_code', 'tenant_slug', 'invite_token', 'app_hint']).toContain(row.mode);
    expect(row.data_condition).toBeTruthy();
    expect(row.profiles.split(';').every((profile) => /^P\d{2}$/.test(profile))).toBe(true);
  });

  it.each([
    ['DI-001', 'P00', { mode: 'email', value: 'first.user@example.test' }, 'resolved', 'first'],
    ['DI-002', 'P00', { mode: 'email', value: 'shared.user@example.test' }, 'multiple', null],
    ['DI-003', 'P00', { mode: 'email', value: 'person@first.example.test' }, 'resolved', 'first'],
    ['DI-004', 'P00', { mode: 'email', value: 'person@shared.example.test' }, 'multiple', null],
    [
      'DI-005',
      'P00',
      { mode: 'email', value: 'person@inactive.example.test' },
      'manual_required',
      null,
    ],
    [
      'DI-006',
      'P00',
      { mode: 'email', value: 'person@inactive.example.test' },
      'manual_required',
      null,
    ],
    ['DI-007', 'P00', { mode: 'email', value: 'missing@example.test' }, 'manual_required', null],
    ['DI-008', 'P08', { mode: 'email', value: 'missing@example.test' }, 'not_found', null],
    ['DI-009', 'P02', { mode: 'email', value: 'person@first.example.test' }, 'not_found', null],
    ['DI-010', 'P03', { mode: 'email', value: 'first.user@example.test' }, 'manual_required', null],
    ['DI-011', 'P04', { mode: 'tenant_code', value: 'first' }, 'resolved', 'first'],
    ['DI-012', 'P04', { mode: 'tenant_code', value: 'inactive-code' }, 'not_found', null],
    ['DI-013', 'P05', { mode: 'tenant_slug', value: 'first' }, 'resolved', 'first'],
    ['DI-014', 'P05', { mode: 'tenant_slug', value: 'inactive' }, 'not_found', null],
    ['DI-015', 'P01', { mode: 'invite_token', value: 'valid-invite' }, 'resolved', 'first'],
    ['DI-016', 'P01', { mode: 'invite_token', value: 'expired-invite' }, 'not_found', null],
    ['DI-017', 'P11', { mode: 'app_hint', value: 'client_first' }, 'resolved', 'first'],
    ['DI-018', 'P00', { mode: 'app_hint', value: 'client_first' }, 'not_found', null],
  ] as const)(
    '%s resolves through the local discovery handler',
    async (_caseId, profileId, requestBody, expectedResult, expectedTenantId) => {
      const env = await buildEnvForTopology('D3_custom_subdomain');
      await seedTenantDataset(env, 'with-inactive');
      await applyLoginEntryProfile(env, 'first', tenantSystemProfiles[profileId]);

      const app = createTenantSystemDiscoveryApp('first');
      const response = await postDiscoveryRequest(
        app,
        env,
        makeCommonHost('D3_custom_subdomain'),
        requestBody
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        result: string;
        candidate?: { tenant_id: string };
        candidates?: Array<{ tenant_id: string }>;
        code?: string;
      };
      expect(body.result).toBe(expectedResult);

      if (expectedTenantId) {
        expect(body.candidate?.tenant_id).toBe(expectedTenantId);
      }

      if (expectedResult === 'multiple') {
        expect(body.candidates?.map((candidate) => candidate.tenant_id).sort()).toEqual([
          'first',
          'second',
        ]);
      }
    }
  );
});
