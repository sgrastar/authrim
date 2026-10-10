import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { CanonicalIdentityRepository, type DatabaseAdapter } from '@authrim/ar-lib-core';
import { describeScimTestHarness } from './scim-test-harness';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
type SqlValue = string | number | null;
const sqlValues = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

/**
 * A real evidence store: the core schema in sqlite, with an account for each user, behind the
 * repository the handlers use. `failBatches` makes the next evidence writes fail.
 */
function realEvidenceStore(userIds: string[]) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  db.exec(
    readFileSync(
      resolve(REPO_ROOT, 'migrations/core/d1/016_assurance_evidence_revoked_by.sql'),
      'utf8'
    )
  );
  for (const id of userIds) {
    db.prepare(
      `INSERT INTO identity_subjects (id, tenant_id, subject_type, created_at, updated_at)
       VALUES (?, 'default', 'person', 100, 100)`
    ).run(`subject:${id}`);
    db.prepare(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
         primary_subject_id, created_at, updated_at)
       VALUES (?, 'default', 'user', 'active', ?, ?, 100, 100)`
    ).run(`account:${id}`, id, `subject:${id}`);
  }
  const control = { failBatches: 0 };
  const run = (sql: string, params?: unknown[]) => ({
    success: true,
    rowsAffected: Number(db.prepare(sql).run(...sqlValues(params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...sqlValues(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...sqlValues(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run(sql, params),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
      if (control.failBatches > 0) {
        control.failBatches -= 1;
        throw new Error('d1 down');
      }
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => run(statement.sql, statement.params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  const repository = new CanonicalIdentityRepository(adapter, 'default');
  const active = (userId: string) =>
    db
      .prepare(
        `SELECT e.assurance_level AS ial, e.verified_at AS verifiedAt, e.issuer_ref AS issuer
           FROM assurance_evidence e
           JOIN identity_accounts a ON a.primary_subject_id = e.subject_id
          WHERE a.legacy_user_id = ? AND e.revoked_at IS NULL ORDER BY e.created_at, e.id`
      )
      .all(userId) as Array<{ ial: string; verifiedAt: number; issuer: string }>;
  const count = () =>
    (db.prepare('SELECT count(*) AS n FROM assurance_evidence').get() as { n: number }).n;
  /** An administrator revokes the person's evidence (through the Admin API's repository calls). */
  const revokeActive = async (userId: string, by = 'admin:operator') => {
    for (const row of await repository.listAssuranceEvidenceForSubject(`subject:${userId}`)) {
      await repository.revokeAssuranceEvidence(row.id, by);
    }
  };
  return { db, adapter, control, repository, active, count, revokeActive };
}

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const BULK_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const URN = 'urn:authrim:params:scim:schemas:extension:assurance:1.0:User';
const TOKEN_REF = 'ref-valid-scim-token';
const VERIFIED = '2026-09-01T00:00:00Z';
const VERIFIED_MS = Date.parse(VERIFIED);
const EXPIRES = '2027-09-01T00:00:00Z';
const claim = (overrides: Record<string, unknown> = {}) => ({
  ial: 'IAL2',
  verifiedAt: VERIFIED_MS,
  expiresAt: null,
  ...overrides,
});

function settingsKv(values: Record<string, string>, options: { failReads?: boolean } = {}) {
  const store = new Map(Object.entries(values));
  return {
    get: vi.fn(async (key: string) => {
      if (options.failReads) throw new Error('kv down');
      return store.get(key) ?? null;
    }),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
  } as unknown as KVNamespace;
}

const defaultIal = (level: string) => ({
  'settings:tenant:default:assurance': JSON.stringify({ 'assurance.default_ial': level }),
});

describeScimTestHarness('SCIM assurance', (harness) => {
  const fetchScim = (path: string, options?: RequestInit) =>
    harness.app.fetch(harness.createRequest(path, options), harness.env as Env);

  function userBody(overrides: Record<string, unknown> = {}) {
    return {
      schemas: [USER_SCHEMA],
      userName: 'assured-user',
      emails: [{ value: 'assured.user@example.com', primary: true }],
      ...overrides,
    };
  }

  const create = (body: Record<string, unknown> = userBody()) =>
    fetchScim('/scim/v2/Users', { method: 'POST', body: JSON.stringify(body) });

  describe('the tenant default IAL for accounts SCIM creates', () => {
    it('is recorded as tenant-policy evidence with the account', async () => {
      harness.env.SETTINGS = settingsKv(defaultIal('IAL2'));

      expect((await create()).status).toBe(201);

      expect(harness.accountCreation.written).toHaveLength(1);
      expect(harness.accountCreation.written[0]?.initialAssurance).toMatchObject({
        level: 'IAL2',
        evidenceType: 'tenant_policy',
        issuerRef: 'tenant_policy',
      });
    });

    it('records nothing at IAL1, the default', async () => {
      harness.env.SETTINGS = settingsKv({});

      expect((await create()).status).toBe(201);

      expect(harness.accountCreation.written[0]?.initialAssurance).toBeNull();
    });

    it('refuses to create the account when it cannot be read', async () => {
      harness.env.SETTINGS = settingsKv({}, { failReads: true });

      const response = await create();

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).not.toBeNull();
      expect(harness.accountCreation.calls).toHaveLength(0);
    });

    it('applies to accounts created by a Bulk operation, which fails alone when unreadable', async () => {
      harness.env.SETTINGS = settingsKv(defaultIal('IAL3'));
      const bulk = (userName: string) =>
        fetchScim('/scim/v2/Bulk', {
          method: 'POST',
          body: JSON.stringify({
            schemas: [BULK_SCHEMA],
            Operations: [
              {
                method: 'POST',
                path: '/Users',
                bulkId: 'one',
                data: userBody({
                  userName,
                  emails: [{ value: `${userName}@example.com`, primary: true }],
                }),
              },
            ],
          }),
        });

      expect((await bulk('bulk-one')).status).toBe(200);
      expect(harness.accountCreation.written[0]?.initialAssurance).toMatchObject({
        level: 'IAL3',
        evidenceType: 'tenant_policy',
      });

      harness.env.SETTINGS = settingsKv({}, { failReads: true });
      const failed = await bulk('bulk-two');
      const body = (await failed.json()) as { Operations: Array<{ status: string }> };
      expect(body.Operations[0]?.status).toBe('503');
      expect(harness.accountCreation.written).toHaveLength(1);
    });
  });

  describe('the assurance extension on create', () => {
    it('records what the token asserts, in place of the tenant default', async () => {
      harness.env.SETTINGS = settingsKv(defaultIal('IAL3'));

      const response = await create(
        userBody({
          schemas: [USER_SCHEMA, URN],
          [URN]: { ial: 'IAL2', verifiedAt: VERIFIED, expiresAt: EXPIRES },
        })
      );

      expect(response.status).toBe(201);
      expect(harness.accountCreation.written).toHaveLength(1);
      expect(harness.accountCreation.written[0]?.initialAssurance).toEqual({
        level: 'IAL2',
        evidenceType: 'scim',
        issuerRef: `scim:${TOKEN_REF}`,
        verifiedAt: VERIFIED_MS,
        expiresAt: Date.parse(EXPIRES),
        contentId: {
          kind: 'scim',
          parts: [TOKEN_REF, 'IAL2', VERIFIED_MS, Date.parse(EXPIRES)],
        },
      });
    });

    it('refuses an extension that is not valid, creating nothing', async () => {
      const response = await create(
        userBody({ schemas: [USER_SCHEMA, URN], [URN]: { ial: 'IAL9', verifiedAt: VERIFIED } })
      );

      expect(response.status).toBe(400);
      expect(((await response.json()) as { scimType: string }).scimType).toBe('invalidValue');
      expect(harness.accountCreation.calls).toHaveLength(0);
    });

    it('applies to a Bulk create too', async () => {
      const response = await fetchScim('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify({
          schemas: [BULK_SCHEMA],
          Operations: [
            {
              method: 'POST',
              path: '/Users',
              bulkId: 'one',
              data: userBody({
                schemas: [USER_SCHEMA, URN],
                [URN]: { ial: 'IAL3', verifiedAt: VERIFIED },
              }),
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(harness.accountCreation.written[0]?.initialAssurance).toMatchObject({
        level: 'IAL3',
        evidenceType: 'scim',
        issuerRef: `scim:${TOKEN_REF}`,
      });
    });
  });

  describe('the assurance extension on replace', () => {
    const put = (body: Record<string, unknown>, token = 'valid-scim-token') =>
      fetchScim('/scim/v2/Users/user-001', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const withExtension = (extension: unknown) =>
      userBody({ userName: 'johndoe', schemas: [USER_SCHEMA, URN], [URN]: extension });

    it('replaces what the token asserts', async () => {
      const response = await put(withExtension({ ial: 'IAL2', verifiedAt: VERIFIED }));

      expect(response.status).toBe(200);
      expect(harness.assurance.applied).toEqual([
        { userId: 'user-001', tokenRef: TOKEN_REF, claim: claim() },
      ]);
    });

    it('revokes what the token asserted when the extension is left out', async () => {
      const response = await put(userBody({ userName: 'johndoe' }));

      expect(response.status).toBe(200);
      expect(harness.assurance.applied).toEqual([
        { userId: 'user-001', tokenRef: TOKEN_REF, claim: null },
      ]);
    });

    it('revokes only the claim of the token that replaced the user', async () => {
      await put(userBody({ userName: 'johndoe' }), 'other-scim-token');

      expect(harness.assurance.applied).toEqual([
        { userId: 'user-001', tokenRef: 'ref-other-scim-token', claim: null },
      ]);
    });

    it('treats a null extension as none', async () => {
      await put(withExtension(null));

      expect(harness.assurance.applied[0]?.claim).toBeNull();
    });

    it('refuses an extension that is not valid, changing nothing', async () => {
      const response = await put(withExtension({ ial: 'IAL2' }));

      expect(response.status).toBe(400);
      expect(harness.assurance.applied).toEqual([]);
      expect(harness.users.get('user-001')?.preferred_username).toBe('johndoe');
    });

    it('fails the request when the claim cannot be written, so it is not taken for withdrawn', async () => {
      harness.assurance.failApply = true;

      const response = await put(userBody({ userName: 'johndoe' }));

      expect(response.status).toBe(500);
    });

    it('is applied by a Bulk replace as well', async () => {
      const response = await fetchScim('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify({
          schemas: [BULK_SCHEMA],
          Operations: [
            {
              method: 'PUT',
              path: '/Users/user-001',
              data: withExtension({ ial: 'IAL3', verifiedAt: VERIFIED }),
            },
            { method: 'PUT', path: '/Users/user-002', data: userBody({ userName: 'janesmith' }) },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(harness.assurance.applied).toEqual([
        { userId: 'user-001', tokenRef: TOKEN_REF, claim: claim({ ial: 'IAL3' }) },
        { userId: 'user-002', tokenRef: TOKEN_REF, claim: null },
      ]);
    });
  });

  describe('the assurance extension on patch', () => {
    const patch = (operations: unknown[], path = '/scim/v2/Users/user-001') =>
      fetchScim(path, {
        method: 'PATCH',
        body: JSON.stringify({ schemas: [PATCH_SCHEMA], Operations: operations }),
      });
    const held = () => harness.assurance.claims.set(`user-001\0${TOKEN_REF}`, claim());

    it('changes one attribute of the claim the token holds, keeping the rest', async () => {
      held();

      const response = await patch([{ op: 'replace', path: `${URN}:ial`, value: 'IAL3' }]);

      expect(response.status).toBe(200);
      expect(harness.assurance.applied).toEqual([
        { userId: 'user-001', tokenRef: TOKEN_REF, claim: claim({ ial: 'IAL3' }) },
      ]);
    });

    it('keeps the claim, writing no evidence, when the patch does not touch it', async () => {
      held();

      const response = await patch([{ op: 'replace', path: 'displayName', value: 'John' }]);

      expect(response.status).toBe(200);
      expect(harness.assurance.applied).toEqual([]);
      expect(harness.assurance.claims.get(`user-001\0${TOKEN_REF}`)).toEqual(claim());
    });

    it('withdraws the claim when the extension is removed', async () => {
      held();

      const response = await patch([{ op: 'remove', path: URN }]);

      expect(response.status).toBe(200);
      expect(harness.assurance.applied).toEqual([
        { userId: 'user-001', tokenRef: TOKEN_REF, claim: null },
      ]);
    });

    it('asserts a claim with the whole extension as the value', async () => {
      const response = await patch([
        { op: 'add', value: { [URN]: { ial: 'IAL2', verifiedAt: VERIFIED } } },
      ]);

      expect(response.status).toBe(200);
      expect(harness.assurance.applied).toEqual([
        { userId: 'user-001', tokenRef: TOKEN_REF, claim: claim() },
      ]);
    });

    it('refuses a patch that leaves the claim not valid, changing nothing', async () => {
      held();

      const response = await patch([{ op: 'remove', path: `${URN}:verifiedAt` }]);

      expect(response.status).toBe(400);
      expect(harness.assurance.applied).toEqual([]);
    });

    it('fails the request when what the token holds cannot be read', async () => {
      harness.assurance.failRead = true;

      const response = await patch([{ op: 'replace', path: 'displayName', value: 'John' }]);

      expect(response.status).toBe(500);
      expect(harness.assurance.applied).toEqual([]);
    });

    it('is applied by a Bulk patch as well', async () => {
      held();
      const response = await fetchScim('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify({
          schemas: [BULK_SCHEMA],
          Operations: [
            {
              method: 'PATCH',
              path: '/Users/user-001',
              data: {
                schemas: [PATCH_SCHEMA],
                Operations: [{ op: 'replace', path: `${URN}:ial`, value: 'IAL3' }],
              },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      expect(harness.assurance.applied).toEqual([
        { userId: 'user-001', tokenRef: TOKEN_REF, claim: claim({ ial: 'IAL3' }) },
      ]);
    });
  });

  describe('reading the extension', () => {
    it('returns it only when asked for, as the token holds it', async () => {
      harness.assurance.claims.set(
        `user-001\0${TOKEN_REF}`,
        claim({ expiresAt: Date.parse(EXPIRES) })
      );

      const plain = (await (await fetchScim('/scim/v2/Users/user-001')).json()) as Record<
        string,
        unknown
      >;
      expect(plain[URN]).toBeUndefined();

      const asked = (await (
        await fetchScim(`/scim/v2/Users/user-001?attributes=${encodeURIComponent(URN)}`)
      ).json()) as Record<string, any>;
      expect(asked[URN]).toEqual({
        ial: 'IAL2',
        verifiedAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2027-09-01T00:00:00.000Z',
      });
      expect(asked.schemas).toContain(URN);
      expect(asked.userName).toBeUndefined();
    });

    it('leaves it out when the token holds no claim', async () => {
      const asked = (await (
        await fetchScim(`/scim/v2/Users/user-001?attributes=userName,${encodeURIComponent(URN)}`)
      ).json()) as Record<string, any>;

      expect(asked[URN]).toBeUndefined();
      expect(asked.userName).toBe('johndoe');
    });
  });

  describe('discovery', () => {
    it('lists the extension among the schemas, and as an optional extension of User', async () => {
      const list = (await (await fetchScim('/scim/v2/Schemas')).json()) as {
        totalResults: number;
        Resources: Array<{ id: string; attributes: Array<{ name: string; returned: string }> }>;
      };
      const schema = list.Resources.find((resource) => resource.id === URN);
      expect(list.totalResults).toBe(list.Resources.length);
      expect(schema?.attributes.map((attribute) => attribute.name)).toEqual([
        'ial',
        'verifiedAt',
        'expiresAt',
      ]);
      expect(schema?.attributes.every((attribute) => attribute.returned === 'request')).toBe(true);

      const single = await fetchScim(`/scim/v2/Schemas/${encodeURIComponent(URN)}`);
      expect(single.status).toBe(200);
      expect(await single.json()).toMatchObject({ id: URN, name: 'AssuranceUser' });

      for (const path of ['/scim/v2/ResourceTypes', '/scim/v2/ResourceTypes/User']) {
        const body = JSON.stringify(await (await fetchScim(path)).json());
        expect(body).toContain(`"schema":"${URN}","required":false`);
      }
    });
  });

  describe('with the evidence in a real store', () => {
    let opened: ReturnType<typeof realEvidenceStore> | null = null;
    const open = () => {
      opened = realEvidenceStore(['user-001', 'user-002']);
      harness.assurance.store = opened.adapter as never;
      return opened;
    };
    afterEach(() => {
      opened?.db.close();
      opened = null;
    });

    const put = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      fetchScim('/scim/v2/Users/user-001', {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      });
    const claimBody = (verifiedAt = VERIFIED, ial = 'IAL2', userName = 'johndoe') =>
      userBody({ userName, schemas: [USER_SCHEMA, URN], [URN]: { ial, verifiedAt } });
    const plainBody = (userName = 'johndoe') => userBody({ userName });
    const patch = (operations: unknown[]) =>
      fetchScim('/scim/v2/Users/user-001', {
        method: 'PATCH',
        body: JSON.stringify({ schemas: [PATCH_SCHEMA], Operations: operations }),
      });
    const bulk = (operations: unknown[]) =>
      fetchScim('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify({ schemas: [BULK_SCHEMA], Operations: operations }),
      });
    const taken = () => {
      harness.identifierReplacement.error = new Error(
        'identifier_replacement_reservation_conflict'
      );
    };

    describe('a claim sent again', () => {
      it('records nothing new, and does not bring back a claim an administrator revoked', async () => {
        const store = open();
        expect((await put(claimBody())).status).toBe(200);
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL2', verifiedAt: VERIFIED_MS }]);

        // The same request again changes nothing.
        expect((await put(claimBody())).status).toBe(200);
        expect(store.count()).toBe(1);

        await store.revokeActive('user-001');
        expect(store.active('user-001')).toEqual([]);

        // Sent again with the same content: still revoked, and no second piece of evidence.
        expect((await put(claimBody())).status).toBe(200);
        expect(store.active('user-001')).toEqual([]);
        expect(store.count()).toBe(1);
      });

      it('is new evidence when the claim has changed (another verification)', async () => {
        const store = open();
        await put(claimBody());
        await store.revokeActive('user-001');

        await put(claimBody('2026-09-02T00:00:00Z'));
        expect(store.active('user-001')).toMatchObject([
          { ial: 'IAL2', verifiedAt: Date.parse('2026-09-02T00:00:00Z') },
        ]);
        await put(claimBody('2026-09-02T00:00:00Z', 'IAL3'));
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL3' }]);
        expect(store.count()).toBe(3);
      });

      it('does not bring back what the client itself withdrew either, until it sends a new verification', async () => {
        const store = open();
        await put(claimBody());
        await put(plainBody());
        expect(store.active('user-001')).toEqual([]);

        // The same content again: the same, withdrawn evidence.
        await put(claimBody());
        expect(store.active('user-001')).toEqual([]);
        expect(store.count()).toBe(1);

        await put(claimBody('2026-09-03T00:00:00Z'));
        expect(store.active('user-001')).toMatchObject([
          { ial: 'IAL2', verifiedAt: Date.parse('2026-09-03T00:00:00Z') },
        ]);
      });

      it('leaves the claim in force when a claim replaced earlier is sent again', async () => {
        const store = open();
        await put(claimBody(VERIFIED, 'IAL2'));
        await put(claimBody(VERIFIED, 'IAL3'));
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL3' }]);

        // IAL2 with this verification was replaced: it is not asserted again by being sent.
        expect((await put(claimBody(VERIFIED, 'IAL2'))).status).toBe(200);
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL3' }]);
        expect(store.count()).toBe(2);
      });

      it('is the same evidence whether the claim was made when the user was created or later', async () => {
        const store = open();
        // The user is created with the claim (the evidence written with the account)…
        const created = await create(
          userBody({
            schemas: [USER_SCHEMA, URN],
            [URN]: { ial: 'IAL2', verifiedAt: VERIFIED },
          })
        );
        expect(created.status).toBe(201);
        const initial = harness.accountCreation.written[0]!.initialAssurance as never;
        await store.repository.recordInitialAssurance('subject:user-001', initial);
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL2', verifiedAt: VERIFIED_MS }]);

        // …an administrator revokes it, and the same content sent by PUT stays revoked.
        await store.revokeActive('user-001');
        expect((await put(claimBody())).status).toBe(200);
        expect(store.active('user-001')).toEqual([]);
        expect(store.count()).toBe(1);
      });
    });

    describe('a patch that leaves the claim alone', () => {
      it('does not write evidence at all, so it cannot undo a change made while it ran', async () => {
        const store = open();
        await put(claimBody());
        harness.assurance.applied = [];
        // While the patch runs, another request replaces the claim, then an administrator
        // revokes that.
        harness.identifierReplacement.during = async () => {
          harness.identifierReplacement.during = null;
          await put(claimBody('2026-09-02T00:00:00Z', 'IAL3'));
          await store.revokeActive('user-001');
        };

        const response = await patch([{ op: 'replace', path: 'userName', value: 'patched-name' }]);
        harness.identifierReplacement.during = null;

        expect(response.status).toBe(200);
        // Only the concurrent PUT wrote evidence.
        expect(harness.assurance.applied).toHaveLength(1);
        expect(store.active('user-001')).toEqual([]);
        expect(store.count()).toBe(2);
      });

      it('does not write evidence in a Bulk patch either', async () => {
        const store = open();
        await put(claimBody());
        harness.assurance.applied = [];
        harness.identifierReplacement.during = async () => {
          await store.revokeActive('user-001');
        };

        const response = await bulk([
          {
            method: 'PATCH',
            path: '/Users/user-001',
            data: {
              schemas: [PATCH_SCHEMA],
              Operations: [{ op: 'replace', path: 'userName', value: 'patched-name' }],
            },
          },
        ]);
        harness.identifierReplacement.during = null;

        const body = (await response.json()) as { Operations: Array<{ status: string }> };
        expect(body.Operations[0]?.status).toBe('200');
        expect(harness.assurance.applied).toEqual([]);
        expect(store.active('user-001')).toEqual([]);
      });

      it('a patch that changes the claim records the new one and revokes the previous one', async () => {
        const store = open();
        await put(claimBody());

        const response = await patch([{ op: 'replace', path: `${URN}:ial`, value: 'IAL3' }]);

        expect(response.status).toBe(200);
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL3', verifiedAt: VERIFIED_MS }]);
        expect(store.count()).toBe(2);
      });
    });

    describe('a request that fails', () => {
      it('leaves the evidence as it was when a replacement cannot be applied', async () => {
        const store = open();
        await put(claimBody());
        taken();

        const withNew = await put(claimBody('2026-09-02T00:00:00Z', 'IAL3', 'taken-name'));
        const without = await put(plainBody('taken-name'));

        expect(withNew.status).toBe(409);
        expect(without.status).toBe(409);
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL2', verifiedAt: VERIFIED_MS }]);
        expect(store.count()).toBe(1);
      });

      it('leaves the evidence as it was when a patch cannot be applied', async () => {
        const store = open();
        await put(claimBody());
        taken();

        const response = await patch([
          { op: 'replace', path: 'userName', value: 'taken-name' },
          { op: 'replace', path: `${URN}:ial`, value: 'IAL3' },
        ]);
        const removal = await patch([
          { op: 'replace', path: 'userName', value: 'taken-name' },
          { op: 'remove', path: URN },
        ]);

        expect(response.status).toBe(409);
        expect(removal.status).toBe(409);
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL2' }]);
        expect(store.count()).toBe(1);
      });

      it('leaves the evidence as it was when a Bulk operation cannot be applied', async () => {
        const store = open();
        await put(claimBody());
        taken();

        const response = await bulk([
          { method: 'PUT', path: '/Users/user-001', data: claimBody(VERIFIED, 'IAL3', 'taken') },
          {
            method: 'PATCH',
            path: '/Users/user-001',
            data: {
              schemas: [PATCH_SCHEMA],
              Operations: [
                { op: 'replace', path: 'userName', value: 'taken-name' },
                { op: 'remove', path: URN },
              ],
            },
          },
        ]);

        const body = (await response.json()) as { Operations: Array<{ status: string }> };
        expect(body.Operations.map((operation) => operation.status)).toEqual(['409', '409']);
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL2' }]);
        expect(store.count()).toBe(1);
      });

      it('answers 500, not success, when the evidence fails after the user was written, and the same request completes it', async () => {
        const store = open();
        store.control.failBatches = 1;

        const failed = await put(claimBody(VERIFIED, 'IAL2', 'renamed-john'));

        expect(failed.status).toBe(500);
        // The user was written; the evidence was not.
        expect(harness.users.get('user-001')?.preferred_username).toBe('renamed-john');
        expect(store.active('user-001')).toEqual([]);

        const retried = await put(claimBody(VERIFIED, 'IAL2', 'renamed-john'));
        expect(retried.status).toBe(200);
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL2', verifiedAt: VERIFIED_MS }]);
        expect(store.count()).toBe(1);
      });

      it('does not take a failed withdrawal for a withdrawn claim', async () => {
        const store = open();
        await put(claimBody());
        store.control.failBatches = 1;

        expect((await put(plainBody('renamed-john'))).status).toBe(500);
        expect(store.active('user-001')).toMatchObject([{ ial: 'IAL2' }]);

        expect((await put(plainBody('renamed-john'))).status).toBe(200);
        expect(store.active('user-001')).toEqual([]);
      });

      it('fails the Bulk operation whose evidence failed, apart from the others', async () => {
        const store = open();
        store.control.failBatches = 1;

        const response = await bulk([
          {
            method: 'PUT',
            path: '/Users/user-001',
            data: claimBody(VERIFIED, 'IAL2', 'bulk-john'),
          },
          {
            method: 'PUT',
            path: '/Users/user-002',
            data: claimBody(VERIFIED, 'IAL3', 'bulk-jane'),
          },
        ]);

        const body = (await response.json()) as { Operations: Array<{ status: string }> };
        expect(body.Operations.map((operation) => operation.status)).toEqual(['500', '200']);
        expect(store.active('user-001')).toEqual([]);
        expect(store.active('user-002')).toMatchObject([{ ial: 'IAL3' }]);
      });
    });

    describe('the version of the user', () => {
      const asked = `/scim/v2/Users/user-001?attributes=${encodeURIComponent(URN)}`;

      it('changes when an administrator revokes the claim, so a conditional read is not answered 304', async () => {
        const store = open();
        await put(claimBody());
        const first = await fetchScim(asked);
        const etag = first.headers.get('ETag') ?? '';
        expect(etag).not.toBe('');
        expect(((await first.json()) as Record<string, unknown>)[URN]).toBeDefined();

        // Nothing changed: not modified.
        expect((await fetchScim(asked, { headers: { 'If-None-Match': etag } })).status).toBe(304);

        await store.revokeActive('user-001');

        const conditional = await fetchScim(asked, { headers: { 'If-None-Match': etag } });
        expect(conditional.status).toBe(200);
        expect(conditional.headers.get('ETag')).not.toBe(etag);
        expect(((await conditional.json()) as Record<string, unknown>)[URN]).toBeUndefined();
      });

      it('refuses a stale If-Match after the claim changed, and accepts the current one', async () => {
        const store = open();
        await put(claimBody());
        const etag = (await fetchScim(asked)).headers.get('ETag') ?? '';
        await store.revokeActive('user-001');

        expect((await put(plainBody(), { 'If-Match': etag })).status).toBe(412);
        expect(
          (
            await fetchScim('/scim/v2/Users/user-001', {
              method: 'DELETE',
              headers: { 'If-Match': etag },
            })
          ).status
        ).toBe(412);
        expect((await patch([{ op: 'replace', path: 'displayName', value: 'x' }])).status).toBe(
          200
        );

        const current = (await fetchScim(asked)).headers.get('ETag') ?? '';
        expect((await put(plainBody(), { 'If-Match': current })).status).toBe(200);
      });
    });
  });
});
