import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsEnv } from '../effective-settings';

const { resolveEffectiveSettings } = vi.hoisted(() => ({ resolveEffectiveSettings: vi.fn() }));

vi.mock('../effective-settings', () => ({ resolveEffectiveSettings }));

import { initialAssuranceEvidenceId } from '../identity-assurance';
import {
  DefaultIALUnavailableError,
  resolveOrganisationDefaultIAL,
  resolveTenantPolicyInitialAssurance,
  TENANT_POLICY_EVIDENCE_TYPE,
} from '../organisation-assurance';

const env = {} as EffectiveSettingsEnv;

describe('organisation default IAL', () => {
  beforeEach(() => {
    resolveEffectiveSettings.mockReset();
  });

  it("reads the tenant's assurance.default_ial", async () => {
    resolveEffectiveSettings.mockResolvedValue({ 'assurance.default_ial': 'IAL2' });

    await expect(resolveOrganisationDefaultIAL(env, 't')).resolves.toBe('IAL2');
    expect(resolveEffectiveSettings).toHaveBeenCalledWith(env, 'assurance', { tenantId: 't' });
  });

  it('records nothing at IAL1, whether or not assurance levels are enabled', async () => {
    resolveEffectiveSettings.mockResolvedValue({ 'assurance.default_ial': 'IAL1' });

    await expect(resolveTenantPolicyInitialAssurance(env, 't', 5_000)).resolves.toBeNull();
  });

  it('gives tenant-policy evidence at IAL2 or above, even while assurance levels are off', async () => {
    resolveEffectiveSettings.mockResolvedValue({
      'assurance.default_ial': 'IAL3',
      'assurance.enabled': false,
    });

    await expect(resolveTenantPolicyInitialAssurance(env, 't', 5_000)).resolves.toEqual({
      level: 'IAL3',
      evidenceType: TENANT_POLICY_EVIDENCE_TYPE,
      issuerRef: 'tenant_policy',
      verifiedAt: 5_000,
    });
  });

  it('refuses to guess when the setting cannot be read or is not a level', async () => {
    resolveEffectiveSettings.mockRejectedValue(new Error('kv down'));
    await expect(resolveOrganisationDefaultIAL(env, 't')).rejects.toBeInstanceOf(
      DefaultIALUnavailableError
    );

    resolveEffectiveSettings.mockResolvedValue({ 'assurance.default_ial': 'IAL9' });
    await expect(resolveTenantPolicyInitialAssurance(env, 't')).rejects.toBeInstanceOf(
      DefaultIALUnavailableError
    );
  });

  it('names evidence deterministically per tenant, subject and source', async () => {
    const source = { evidenceType: 'tenant_policy', issuerRef: 'tenant_policy' };
    const first = await initialAssuranceEvidenceId('t', 'subject:u', source);
    expect(first).toMatch(/^assurance-evidence:initial:[0-9a-f]{64}$/);
    expect(await initialAssuranceEvidenceId('t', 'subject:u', source)).toBe(first);
    expect(await initialAssuranceEvidenceId('t2', 'subject:u', source)).not.toBe(first);
    expect(await initialAssuranceEvidenceId('t', 'subject:v', source)).not.toBe(first);
    expect(
      await initialAssuranceEvidenceId('t', 'subject:u', { ...source, issuerRef: 'scim:x' })
    ).not.toBe(first);
  });
});
