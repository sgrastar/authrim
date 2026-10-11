import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { parseClaimsRequest } from '../../utils/oidc-claims';
import {
  requestsEduPersonAssurance,
  resolveAssuranceClaims,
  type AssuranceClaimsInput,
} from '../assurance-claims';
import { IAL_FRAMEWORK } from '../identity-assurance';
import { evaluateUserIAL } from '../identity-assurance-enforcement';

const NOW = 1_800_000_000_000;
const IAL1_URI = 'https://example.org/assurance/IAL1';
const IAL2_URI = 'https://example.org/assurance/IAL2';
const IAL3_URI = 'https://example.org/assurance/IAL3';

const SETTINGS = {
  'assurance.enabled': true,
  'assurance.ial_assurance_values': JSON.stringify({
    IAL1: [IAL1_URI],
    IAL2: [IAL2_URI, IAL1_URI],
    IAL3: [IAL3_URI],
  }),
};

describe('identity assurance claims', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  let settings: Record<string, unknown>;
  const loadSettings = vi.fn(async () => settings);
  const getAdapter = vi.fn(() => adapter);
  const onError = vi.fn();
  let evidenceReads: () => number;

  const addEvidence = (
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
      verified_at: NOW - 86_400_000,
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

  const claimsParameter = (claims: unknown) => parseClaimsRequest(JSON.stringify(claims)).request;

  const resolve = (overrides: Partial<AssuranceClaimsInput> = {}) =>
    resolveAssuranceClaims({
      target: 'userinfo',
      tenantId: 'tenant-a',
      userId: 'user-1',
      scopes: ['openid', 'profile', 'eduperson_assurance'],
      includeScopeClaims: true,
      loadSettings,
      getAdapter,
      onError,
      now: NOW,
      ...overrides,
    });

  beforeEach(() => {
    settings = { ...SETTINGS };
    loadSettings.mockClear();
    getAdapter.mockClear();
    onError.mockClear();
    ({ db, adapter } = sqliteAdapter());
    const query = adapter.query.bind(adapter);
    let reads = 0;
    adapter.query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes('assurance_evidence')) reads += 1;
      return query(sql, params);
    }) as typeof adapter.query;
    evidenceReads = () => reads;
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

  describe('eduperson_assurance', () => {
    it('releases the values of every IAL up to the person’s, lowest first and without repeats', async () => {
      addEvidence('ev-1', 'IAL2');
      expect(await resolve()).toEqual({ eduperson_assurance: [IAL1_URI, IAL2_URI] });
      expect(evidenceReads()).toBe(1);
    });

    it('releases only the person’s own IAL: IAL3 values need IAL3 evidence', async () => {
      addEvidence('ev-1', 'IAL2');
      expect((await resolve()).eduperson_assurance).not.toContain(IAL3_URI);
      addEvidence('ev-2', 'IAL3');
      expect((await resolve()).eduperson_assurance).toEqual([IAL1_URI, IAL2_URI, IAL3_URI]);
    });

    it('releases the IAL1 values to a person without evidence, and nothing when there are none', async () => {
      expect(await resolve()).toEqual({ eduperson_assurance: [IAL1_URI] });
      settings['assurance.ial_assurance_values'] = JSON.stringify({ IAL2: [IAL2_URI] });
      expect(await resolve()).toEqual({});
    });

    it('stops with the next response once the evidence is revoked or expires', async () => {
      addEvidence('ev-1', 'IAL2');
      expect((await resolve()).eduperson_assurance).toContain(IAL2_URI);
      db.prepare(`UPDATE assurance_evidence SET revoked_at = ? WHERE id = 'ev-1'`).run(NOW);
      expect((await resolve()).eduperson_assurance).toEqual([IAL1_URI]);

      addEvidence('ev-2', 'IAL2', { expires_at: NOW + 1000 });
      expect((await resolve({ now: NOW })).eduperson_assurance).toContain(IAL2_URI);
      expect((await resolve({ now: NOW + 1000 })).eduperson_assurance).toEqual([IAL1_URI]);
    });

    it('does not count evidence that is not in force', async () => {
      addEvidence('future', 'IAL2', { verified_at: NOW + 10 });
      addEvidence('unverified', 'IAL2', { verified_at: null });
      addEvidence('other', 'IAL2', { framework: 'eidas' });
      expect((await resolve()).eduperson_assurance).toEqual([IAL1_URI]);
    });

    it('reads only the tenant’s own evidence', async () => {
      addEvidence('ev-1', 'IAL2');
      expect((await resolve({ tenantId: 'tenant-b' })).eduperson_assurance).toEqual([IAL1_URI]);
    });

    it('releases to a claims-parameter request in a response that carries no scope claims, when the policy allows it', async () => {
      addEvidence('ev-1', 'IAL2');
      const claimsRequest = claimsParameter({ id_token: { eduperson_assurance: null } });
      const request = {
        target: 'id_token' as const,
        claimsRequest,
        includeScopeClaims: false,
      };
      // The scope grants it, and so lets the claims parameter ask.
      expect((await resolve(request)).eduperson_assurance).toEqual([IAL1_URI, IAL2_URI]);
      // Without the scope, only a policy that lets the claim through without it releases it.
      expect(
        (await resolve({ ...request, scopes: ['openid'] })).eduperson_assurance
      ).toBeUndefined();
      expect(
        (
          await resolve({
            ...request,
            scopes: ['openid'],
            clientPolicy: { claims_parameter_policy: { eduperson_assurance: 'claims_allowed' } },
          })
        ).eduperson_assurance
      ).toEqual([IAL1_URI, IAL2_URI]);
    });
  });

  describe('when it reads nothing', () => {
    const untouched = () => {
      expect(getAdapter).not.toHaveBeenCalled();
      expect(evidenceReads()).toBe(0);
    };

    it('does not read settings or evidence when the response asks for neither claim', async () => {
      addEvidence('ev-1', 'IAL2');
      expect(await resolve({ scopes: ['openid', 'profile'] })).toEqual({});
      expect(
        await resolve({
          scopes: ['openid', 'profile', 'eduperson_assurance'],
          includeScopeClaims: false,
        })
      ).toEqual({});
      expect(
        await resolve({
          claimsRequest: claimsParameter({ userinfo: { email: null } }),
          scopes: ['openid', 'email'],
        })
      ).toEqual({});
      expect(loadSettings).not.toHaveBeenCalled();
      untouched();
    });

    it('does not read evidence while assurance is off, whatever is configured', async () => {
      settings['assurance.enabled'] = false;
      expect(await resolve()).toEqual({});
      delete settings['assurance.enabled'];
      expect(await resolve()).toEqual({});
      untouched();
    });

    it('does not read evidence when no assurance values are configured', async () => {
      settings = { 'assurance.enabled': true };
      expect(await resolve()).toEqual({});
      settings['assurance.ial_assurance_values'] = '{}';
      expect(await resolve()).toEqual({});
      settings['assurance.ial_assurance_values'] = 'not json';
      expect(await resolve()).toEqual({});
      untouched();
    });

    it('does not read evidence for a claim the client policy forbids', async () => {
      expect(
        await resolve({
          clientPolicy: { claims_parameter_policy: { eduperson_assurance: 'forbidden' } },
        })
      ).toEqual({});
      untouched();
    });
  });

  describe('when the read fails', () => {
    it('releases nothing and reports it, rather than taking the person for IAL1', async () => {
      addEvidence('ev-1', 'IAL2');
      const failure = new Error('database is down');
      vi.spyOn(adapter, 'query').mockRejectedValue(failure);
      expect(await resolve()).toEqual({});
      expect(onError).toHaveBeenCalledWith(expect.any(String), failure);
    });

    it('treats an unreachable store and unreadable settings the same way', async () => {
      const unreachable = new Error('account route unavailable');
      expect(
        await resolve({
          getAdapter: () => {
            throw unreachable;
          },
        })
      ).toEqual({});
      expect(onError).toHaveBeenCalledWith(expect.any(String), unreachable);

      onError.mockClear();
      const unreadable = new Error('settings are down');
      expect(
        await resolve({
          loadSettings: async () => {
            throw unreadable;
          },
        })
      ).toEqual({});
      expect(onError).toHaveBeenCalledWith(expect.any(String), unreadable);
    });
  });

  describe('with an IAL requirement of the same request', () => {
    const requirement = (requestScope: object | undefined) =>
      evaluateUserIAL({
        required: 'IAL2',
        tenantId: 'tenant-a',
        userId: 'user-1',
        getAdapter,
        requestScope,
        now: NOW,
      });

    it('reads the evidence once for the requirement and the claim', async () => {
      addEvidence('ev-1', 'IAL2');
      const requestScope = {};
      expect(await requirement(requestScope)).toMatchObject({ outcome: 'met' });
      expect((await resolve({ requestScope })).eduperson_assurance).toEqual([IAL1_URI, IAL2_URI]);
      expect(evidenceReads()).toBe(1);
    });

    it('reads again for another request, so a revocation is seen at once', async () => {
      addEvidence('ev-1', 'IAL2');
      expect(await requirement({})).toMatchObject({ outcome: 'met' });
      db.prepare(`UPDATE assurance_evidence SET revoked_at = ? WHERE id = 'ev-1'`).run(NOW);
      expect((await resolve({ requestScope: {} })).eduperson_assurance).toEqual([IAL1_URI]);
      expect(evidenceReads()).toBe(2);
      // Without a request scope nothing is shared.
      await requirement(undefined);
      await resolve();
      expect(evidenceReads()).toBe(4);
    });

    it('does not share the evidence of another person or tenant', async () => {
      addEvidence('ev-1', 'IAL2');
      const requestScope = {};
      await requirement(requestScope);
      expect((await resolve({ requestScope, userId: 'user-2' })).eduperson_assurance).toEqual([
        IAL1_URI,
      ]);
      expect((await resolve({ requestScope, tenantId: 'tenant-b' })).eduperson_assurance).toEqual([
        IAL1_URI,
      ]);
      expect(evidenceReads()).toBe(3);
    });

    it('does not keep a failed read', async () => {
      addEvidence('ev-1', 'IAL2');
      const requestScope = {};
      const query = adapter.query;
      adapter.query = (async () => {
        throw new Error('database is down');
      }) as typeof adapter.query;
      expect(await requirement(requestScope)).toMatchObject({ outcome: 'unavailable' });
      adapter.query = query;
      expect((await resolve({ requestScope })).eduperson_assurance).toEqual([IAL1_URI, IAL2_URI]);
    });
  });
});

describe('requestsEduPersonAssurance', () => {
  it('does not take Object property names for requests', () => {
    expect(
      requestsEduPersonAssurance({
        target: 'userinfo',
        scopes: ['openid'],
        includeScopeClaims: true,
        claimsRequest: parseClaimsRequest('{"userinfo":{"constructor":null,"__proto__":null}}')
          .request,
      })
    ).toBe(false);
  });
});
