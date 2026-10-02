import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: null as DatabaseAdapter | null,
  audit: vi.fn(),
  actor: 'operator-a',
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  getTenantMetadataContextFromHono: vi.fn(() => undefined),
  createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
  createAuditLogFromContext: mocks.audit,
}));

vi.mock('../tenant-routed-storage', () => ({ usesRoutedAccountStorage: vi.fn(() => false) }));

vi.mock('../admin-tenant-access', () => ({
  getAdminAuth: vi.fn(() => ({ userId: 'admin-a', actorId: mocks.actor })),
}));

vi.mock('../admin-shared', () => ({ logSanitizedError: vi.fn() }));

import {
  adminUserAssuranceEvidenceCreateHandler,
  adminUserAssuranceEvidenceRevokeHandler,
  adminUserAssuranceGetHandler,
} from '../admin-user-assurance';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

function sqliteAdapter(db: DatabaseSync): DatabaseAdapter {
  const run = (sql: string, params?: unknown[]) => ({
    success: true,
    rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
  });
  return {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => run(sql, params),
    batch: async (statements: Array<{ sql: string; params?: unknown[] }>) =>
      statements.map((statement) => run(statement.sql, statement.params)),
  } as unknown as DatabaseAdapter;
}

function context(
  input: {
    id?: string;
    evidenceId?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {}
) {
  return {
    req: {
      param: vi.fn((name: string) =>
        name === 'evidenceId' ? input.evidenceId : (input.id ?? 'user-a')
      ),
      header: vi.fn((name: string) =>
        name === 'Idempotency-Key' ? input.idempotencyKey : undefined
      ),
      json: vi.fn(async () => input.body),
    },
    env: {},
    json: vi.fn((body: unknown, status = 200) => Response.json(body, { status })),
  } as never;
}

const json = async (response: Response) => (await response.json()) as Record<string, any>;

describe('Admin identity assurance', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.mockResolvedValue(undefined);
    mocks.actor = 'operator-a';
    db = new DatabaseSync(':memory:');
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
    db.exec(
      `INSERT INTO identity_subjects (id, tenant_id, subject_type, created_at, updated_at)
       VALUES ('subject-a', 'tenant-a', 'person', 100, 100);
       INSERT INTO identity_accounts (
         id, tenant_id, account_type, lifecycle_state, legacy_user_id, primary_subject_id,
         created_at, updated_at
       ) VALUES ('account-a', 'tenant-a', 'person', 'active', 'user-a', 'subject-a', 100, 100)`
    );
    mocks.adapter = sqliteAdapter(db);
  });

  afterEach(() => db.close());

  it('records evidence once per key, audited before it is in force, and reads the IAL it gives', async () => {
    const before = await json(await adminUserAssuranceGetHandler(context()));
    expect(before).toMatchObject({ effective_ial: { level: 'IAL1', evidence_id: null } });

    const request = {
      idempotencyKey: 'record-ial2-request',
      body: {
        assurance_level: 'IAL2',
        evidence_type: 'document_check',
        verified_at: '2026-09-01T00:00:00.000Z',
        evidence_hash: 'sha256:0123456789abcdef',
      },
    };
    // Its audit fails: it is stored but not in force, and the same key finishes it.
    mocks.audit.mockRejectedValueOnce(new Error('audit_unavailable'));
    expect((await adminUserAssuranceEvidenceCreateHandler(context(request))).status).toBe(503);
    expect(await json(await adminUserAssuranceGetHandler(context()))).toMatchObject({
      effective_ial: { level: 'IAL1' },
      evidence: [{ status: 'pending' }],
    });

    const created = await adminUserAssuranceEvidenceCreateHandler(context(request));
    expect(created.status).toBe(200);
    const evidence = await json(created);
    expect(evidence).toMatchObject({
      evidence_type: 'document_check',
      issuer_ref: 'admin:operator-a',
      assurance_level: 'IAL2',
      status: 'active',
    });
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      'user.assurance.evidence_recorded',
      'user',
      'user-a',
      expect.objectContaining({
        evidence_id: evidence.evidence_id,
        assurance_level: 'IAL2',
        verified_at: '2026-09-01T00:00:00.000Z',
      }),
      'warning',
      `user.assurance.evidence_recorded.${evidence.evidence_id}`,
      expect.any(Number)
    );
    // Again with the key: the same evidence; with the key and other evidence: refused.
    expect((await adminUserAssuranceEvidenceCreateHandler(context(request))).status).toBe(200);
    const reused = await adminUserAssuranceEvidenceCreateHandler(
      context({ ...request, body: { ...request.body, assurance_level: 'IAL3' } })
    );
    expect(reused.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM assurance_evidence').get()).toEqual({ n: 1 });

    expect(await json(await adminUserAssuranceGetHandler(context()))).toMatchObject({
      effective_ial: { level: 'IAL2', evidence_id: evidence.evidence_id },
      evidence: [{ evidence_id: evidence.evidence_id, status: 'active' }],
    });
  });

  it('refuses what an administrator cannot record', async () => {
    const valid = { assurance_level: 'IAL2', evidence_type: 'in_person_check' };
    for (const [body, key] of [
      [valid, undefined],
      [{ ...valid, assurance_level: 'AAL2' }, 'key-1-abcdefgh'],
      [{ ...valid, evidence_type: 'scim' }, 'key-2-abcdefgh'],
      [{ ...valid, evidence_type: 'tenant_policy' }, 'key-3-abcdefgh'],
      [{ ...valid, verified_at: '2999-01-01T00:00:00.000Z' }, 'key-4-abcdefgh'],
      [{ ...valid, expires_at: '2000-01-01T00:00:00.000Z' }, 'key-5-abcdefgh'],
      [{ ...valid, evidence_hash: 'short' }, 'key-6-abcdefgh'],
      [{ ...valid, evidence_storage_ref: 'has spaces' }, 'key-7-abcdefgh'],
      [{ ...valid, notes: 'free text' }, 'key-8-abcdefgh'],
    ] as Array<[unknown, string | undefined]>) {
      const response = await adminUserAssuranceEvidenceCreateHandler(
        context({ body, idempotencyKey: key })
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (
        await adminUserAssuranceEvidenceCreateHandler(
          context({ id: 'nobody', body: valid, idempotencyKey: 'key-9-abcdefgh' })
        )
      ).status
    ).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('answers a retry from what is stored, after its expiry and without a verification time', async () => {
    const request = {
      idempotencyKey: 'record-expiring',
      body: {
        assurance_level: 'IAL2',
        evidence_type: 'admin_attestation',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    const first = await adminUserAssuranceEvidenceCreateHandler(context(request));
    expect(first.status).toBe(201);
    const recorded = await json(first);
    db.prepare('UPDATE assurance_evidence SET expires_at = 1').run();
    const retried = await adminUserAssuranceEvidenceCreateHandler(
      context({ ...request, body: { ...request.body, expires_at: '1970-01-01T00:00:00.001Z' } })
    );
    expect(retried.status).toBe(200);
    expect(await json(retried)).toMatchObject({
      evidence_id: recorded.evidence_id,
      verified_at: recorded.verified_at,
      status: 'expired',
    });
  });

  it('takes only an opaque reference to the proofing record', async () => {
    for (const ref of [
      'data:application/json,{"name":"Taro"}',
      'https://records.example/case?name=taro',
      'mailto:taro@example.com',
      'case 123',
    ]) {
      const response = await adminUserAssuranceEvidenceCreateHandler(
        context({
          idempotencyKey: `ref-${ref.length}-abcdefgh`,
          body: {
            assurance_level: 'IAL2',
            evidence_type: 'document_check',
            evidence_storage_ref: ref,
          },
        })
      );
      expect(response.status, ref).toBe(400);
    }
    expect(
      (
        await adminUserAssuranceEvidenceCreateHandler(
          context({
            idempotencyKey: 'ref-ok-abcdefgh',
            body: {
              assurance_level: 'IAL2',
              evidence_type: 'document_check',
              evidence_storage_ref: 'urn:case:2026/0012',
            },
          })
        )
      ).status
    ).toBe(201);
  });

  it('reads and revokes evidence of a suspended account', async () => {
    db.prepare("UPDATE identity_accounts SET lifecycle_state = 'suspended'").run();
    expect((await adminUserAssuranceGetHandler(context())).status).toBe(200);
    db.prepare("UPDATE identity_accounts SET lifecycle_state = 'deleted'").run();
    expect((await adminUserAssuranceGetHandler(context())).status).toBe(404);
  });

  it('revokes before auditing, and audits a revocation retried after its audit failed', async () => {
    const created = await json(
      await adminUserAssuranceEvidenceCreateHandler(
        context({
          idempotencyKey: 'record-for-revoke',
          body: { assurance_level: 'IAL2', evidence_type: 'admin_attestation' },
        })
      )
    );
    const revoke = context({ evidenceId: created.evidence_id });
    mocks.audit.mockRejectedValueOnce(new Error('audit_unavailable'));
    expect((await adminUserAssuranceEvidenceRevokeHandler(revoke)).status).toBe(503);
    // In force no longer, though its audit failed.
    expect(await json(await adminUserAssuranceGetHandler(context()))).toMatchObject({
      effective_ial: { level: 'IAL1' },
    });
    // Another administrator finishes it: the audit names the one who revoked it.
    mocks.actor = 'operator-b';
    const retried = await adminUserAssuranceEvidenceRevokeHandler(revoke);
    expect(retried.status).toBe(200);
    expect(await json(retried)).toMatchObject({
      status: 'revoked',
      revoked_by: 'admin:operator-a',
    });
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      'user.assurance.evidence_revoked',
      'user',
      'user-a',
      expect.objectContaining({
        evidence_id: created.evidence_id,
        revoked_by: 'admin:operator-a',
      }),
      'warning',
      `user.assurance.evidence_revoked.${created.evidence_id}`,
      expect.any(Number)
    );
    // Another person's evidence is not found through this one.
    db.exec(
      `INSERT INTO assurance_evidence (id, tenant_id, subject_id, evidence_type, created_at, updated_at)
       VALUES ('other', 'tenant-a', 'subject-b', 'scim', 1, 1)`
    );
    expect(
      (await adminUserAssuranceEvidenceRevokeHandler(context({ evidenceId: 'other' }))).status
    ).toBe(404);
  });
});
