import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { IAL_FRAMEWORK } from '../identity-assurance';
import { evaluateUserIAL, resolveRequiredIAL } from '../identity-assurance-enforcement';

const NOW = 1_800_000_000_000;

describe('resolveRequiredIAL', () => {
  const map = JSON.stringify({ payroll: 'IAL2', records: 'IAL3', open: 'IAL1' });
  const on = { 'assurance.enabled': true, 'assurance.scope_ial_requirements': map };

  it('requires nothing when nothing is configured', () => {
    expect(resolveRequiredIAL({ assuranceSettings: {}, scope: 'openid payroll' })).toBeNull();
    expect(
      resolveRequiredIAL({
        assuranceSettings: { 'assurance.enabled': true },
        scope: 'openid payroll',
      })
    ).toBeNull();
  });

  it('applies the scope map only while assurance is on', () => {
    expect(
      resolveRequiredIAL({
        assuranceSettings: { ...on, 'assurance.enabled': false },
        scope: 'payroll',
      })
    ).toBeNull();
    expect(
      resolveRequiredIAL({
        assuranceSettings: { 'assurance.scope_ial_requirements': map },
        scope: 'payroll',
      })
    ).toBeNull();
    expect(resolveRequiredIAL({ assuranceSettings: on, scope: 'openid payroll' })).toBe('IAL2');
    expect(resolveRequiredIAL({ assuranceSettings: on, scope: ['payroll', 'records'] })).toBe(
      'IAL3'
    );
    expect(resolveRequiredIAL({ assuranceSettings: on, scope: 'openid open' })).toBeNull();
  });

  it('applies the client minimum whether or not assurance is on', () => {
    expect(
      resolveRequiredIAL({ assuranceSettings: {}, scope: 'openid', clientMinimumIAL: 'IAL2' })
    ).toBe('IAL2');
    expect(
      resolveRequiredIAL({
        assuranceSettings: { ...on, 'assurance.enabled': false },
        scope: 'payroll',
        clientMinimumIAL: 'IAL3',
      })
    ).toBe('IAL3');
    expect(
      resolveRequiredIAL({ assuranceSettings: {}, scope: '', clientMinimumIAL: 'IAL1' })
    ).toBeNull();
    expect(
      resolveRequiredIAL({ assuranceSettings: {}, scope: undefined, clientMinimumIAL: null })
    ).toBeNull();
  });

  it('takes the highest of the client minimum and the scopes', () => {
    expect(
      resolveRequiredIAL({ assuranceSettings: on, scope: 'payroll', clientMinimumIAL: 'IAL3' })
    ).toBe('IAL3');
    expect(
      resolveRequiredIAL({ assuranceSettings: on, scope: 'records', clientMinimumIAL: 'IAL2' })
    ).toBe('IAL3');
  });

  it('does not take a scope named like an Object property for a requirement', () => {
    expect(
      resolveRequiredIAL({ assuranceSettings: on, scope: 'toString __proto__ constructor' })
    ).toBeNull();
  });
});

describe('evaluateUserIAL against the real schema', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  const getAdapter = vi.fn(() => adapter);

  const evidence = (
    id: string,
    level: string,
    overrides: Partial<{
      framework: string | null;
      verified_at: number | null;
      expires_at: number | null;
      revoked_at: number | null;
    }> = {}
  ) => {
    const row = {
      framework: IAL_FRAMEWORK,
      verified_at: NOW - 1_000,
      expires_at: null,
      revoked_at: null,
      ...overrides,
    };
    db.prepare(
      `INSERT INTO assurance_evidence
         (id, tenant_id, subject_id, evidence_type, assurance_framework, assurance_level,
          verified_at, expires_at, revoked_at, created_at, updated_at)
       VALUES (?, 'tenant-a', 'subject:user-1', 'admin_attestation', ?, ?, ?, ?, ?, 1, 1)`
    ).run(id, row.framework, level, row.verified_at, row.expires_at, row.revoked_at);
  };

  beforeEach(() => {
    getAdapter.mockClear();
    ({ db, adapter } = sqliteAdapter());
    db.prepare(
      `INSERT INTO identity_subjects (id, tenant_id, subject_type, created_at, updated_at)
       VALUES ('subject:user-1', 'tenant-a', 'person', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO identity_accounts
         (id, tenant_id, account_type, legacy_user_id, primary_subject_id, created_at, updated_at)
       VALUES ('account:user-1', 'tenant-a', 'user', 'user-1', 'subject:user-1', 1, 1)`
    ).run();
  });

  const evaluate = (required: 'IAL1' | 'IAL2' | 'IAL3' | null, userId = 'user-1') =>
    evaluateUserIAL({ required, tenantId: 'tenant-a', userId, getAdapter, now: NOW });

  it('does not touch the store when nothing is required', async () => {
    const spy = vi.spyOn(adapter, 'query');
    expect(await evaluate(null)).toEqual({ outcome: 'not_required' });
    expect(getAdapter).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('meets a requirement the evidence supports', async () => {
    evidence('ev-1', 'IAL2');
    expect(await evaluate('IAL2')).toEqual({ outcome: 'met', required: 'IAL2', actual: 'IAL2' });
    expect(await evaluate('IAL3')).toEqual({
      outcome: 'insufficient',
      required: 'IAL3',
      actual: 'IAL2',
    });
  });

  it('treats a person without evidence as IAL1', async () => {
    expect(await evaluate('IAL2')).toEqual({
      outcome: 'insufficient',
      required: 'IAL2',
      actual: 'IAL1',
    });
    expect(await evaluate('IAL2', 'nobody')).toMatchObject({ outcome: 'insufficient' });
  });

  it('counts only evidence that is verified, unexpired, unrevoked and under the NIST framework', async () => {
    evidence('revoked', 'IAL2', { revoked_at: NOW - 10 });
    evidence('expired', 'IAL2', { expires_at: NOW - 10 });
    evidence('future', 'IAL2', { verified_at: NOW + 10 });
    evidence('unverified', 'IAL2', { verified_at: null });
    evidence('other', 'IAL2', { framework: 'eidas' });
    expect(await evaluate('IAL2')).toMatchObject({ outcome: 'insufficient', actual: 'IAL1' });
  });

  it('stops meeting the requirement as soon as the evidence is revoked', async () => {
    evidence('ev-1', 'IAL2');
    expect(await evaluate('IAL2')).toMatchObject({ outcome: 'met' });
    db.prepare(`UPDATE assurance_evidence SET revoked_at = ? WHERE id = 'ev-1'`).run(NOW);
    expect(await evaluate('IAL2')).toMatchObject({ outcome: 'insufficient', actual: 'IAL1' });
  });

  it('reads only the tenant’s own evidence', async () => {
    evidence('ev-1', 'IAL2');
    expect(
      await evaluateUserIAL({
        required: 'IAL2',
        tenantId: 'tenant-b',
        userId: 'user-1',
        getAdapter,
        now: NOW,
      })
    ).toMatchObject({ outcome: 'insufficient', actual: 'IAL1' });
  });

  it('reports a failed read as unavailable, never as IAL1 or as met', async () => {
    evidence('ev-1', 'IAL2');
    const failure = new Error('database is down');
    vi.spyOn(adapter, 'query').mockRejectedValue(failure);
    expect(await evaluate('IAL2')).toEqual({
      outcome: 'unavailable',
      required: 'IAL2',
      error: failure,
    });
  });

  it('takes a subject with no account in the tenant for IAL1, without a read', async () => {
    const spy = vi.spyOn(adapter, 'query');
    expect(
      await evaluateUserIAL({ required: 'IAL2', tenantId: 'tenant-a', userId: null, getAdapter })
    ).toEqual({ outcome: 'insufficient', required: 'IAL2', actual: 'IAL1' });
    expect(
      await evaluateUserIAL({ required: null, tenantId: 'tenant-a', userId: null, getAdapter })
    ).toEqual({ outcome: 'not_required' });
    expect(getAdapter).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports a store that cannot be reached as unavailable', async () => {
    const failure = new Error('account route unavailable');
    expect(
      await evaluateUserIAL({
        required: 'IAL2',
        tenantId: 'tenant-a',
        userId: 'user-1',
        getAdapter: () => {
          throw failure;
        },
      })
    ).toEqual({ outcome: 'unavailable', required: 'IAL2', error: failure });
  });
});
