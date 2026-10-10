import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
const state = vi.hoisted(() => ({
  prior: false,
  pending: true,
  matches: [] as unknown[],
  events: [] as string[],
  write: vi.fn(),
  publish: vi.fn(),
  lookup: vi.fn(),
  persist: vi.fn(),
  sync: vi.fn(),
  applyAssurance: vi.fn(),
  resumeWrites: false,
  store: null as unknown,
}));
vi.mock('../user-import-assurance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../user-import-assurance')>();
  return {
    ...actual,
    // With a real store (a sqlite database holding the account), the evidence is the real
    // repository's; otherwise the call is only recorded.
    applyImportedAssurance: async (
      adapter: unknown,
      ...args: Parameters<typeof actual.applyImportedAssurance> extends [unknown, ...infer R]
        ? R
        : never
    ) => {
      state.applyAssurance(adapter, ...args);
      if (!state.store) return 'recorded';
      return actual.applyImportedAssurance(state.store as DatabaseAdapter, ...args);
    },
  };
});
vi.mock('../account-creation-operation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../account-creation-operation')>()),
  AccountCreationOperationRepository: class {
    async findForActor() {
      return state.prior ? { status: 'directory_pending' } : null;
    }
  },
}));
vi.mock('../cross-shard-account-list', () => ({
  CrossShardAccountExactSearchService: class {
    find(input: unknown) {
      state.lookup(input);
      return Promise.resolve(state.matches);
    }
  },
}));
vi.mock('../account-authoritative-write', () => ({
  writeCanonicalAccountAuthoritative: async (input: unknown) => {
    state.events.push('canonical');
    state.write(input);
    return { userId: 'csv-user' };
  },
}));
vi.mock('../account-directory-producer', () => ({
  executeDurableInitialAccountDirectoryWrite: (...args: unknown[]) => state.publish(...args),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    generateUserIdFromSettings: async () => 'csv-user',
    validateCustomClaimWrite: async () => ({
      ok: true,
      nonPiiValues: {},
      piiValues: {},
      nonPiiKeysToDelete: [],
      piiKeysToDelete: [],
    }),
    persistCustomClaimWrite: async (input: unknown) => {
      state.events.push('custom');
      state.persist(input);
    },
    syncUserLifecycleState: async () => {
      state.events.push('lifecycle');
    },
    invalidateUserCache: async () => {},
    transitionAccountAuthenticationState: async () => {
      state.events.push('auth-state');
    },
    CanonicalRuntimeUserStore: class {
      async findById() {
        return { id: 'existing', registration_state: 'registered', active: 1, email_verified: 1 };
      }
      async syncUser(input: unknown) {
        state.events.push('update');
        await state.sync(input);
      }
    },
  };
});
import { DefaultIALUnavailableError, InitialAssuranceRecordError } from '@authrim/ar-lib-core';
import {
  createFailureEntry,
  ImportAssuranceStepError,
  importRowErrorDisposition,
  parseUserImportCsv,
  processImportedRow,
} from '../user-import-jobs';
function adapter(): DatabaseAdapter {
  return {
    getType: () => 'mock',
    query: async () => [],
    queryOne: async () => null,
    batch: async () => [],
    transaction: async (fn: (db: DatabaseAdapter) => Promise<unknown>) => fn(adapter()),
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'mock' }),
    close: async () => {},
    execute: async (sql: string) => {
      state.events.push(sql.startsWith('INSERT') ? 'boundary-open' : 'boundary-close');
      return { success: true, rowsAffected: 1 };
    },
  } as DatabaseAdapter;
}
const metadata = adapter(),
  accountCore = adapter(),
  accountPii = adapter();
const runtime = {
  tenantId: 'tenant-a',
  jobId: 'job-a',
  env: { ACCOUNT_CORE: accountCore, ACCOUNT_PII: accountPii } as unknown as Env,
  metadata,
};
const options = { skip_header: true, on_duplicate: 'update' as const, validate_only: false };
beforeEach(() => {
  vi.clearAllMocks();
  state.prior = false;
  state.resumeWrites = false;
  state.pending = true;
  state.matches = [];
  state.events = [];
  state.publish.mockImplementation(async (_env, input, dependencies) => {
    // A creation that is not finished (its operation is `writing`) is written again.
    if (!state.prior || state.resumeWrites) {
      await dependencies.writeAuthoritative({
        publication: {
          accountId: 'account:csv-user',
          tenantId: 'tenant-a',
          operationId: input.candidateOperationId,
        },
        tenantCoreUsers: accountCore,
        tenantPii: accountPii,
      });
      state.events.push('publish');
    }
    return { delivery: { status: state.pending ? 202 : 201 }, operation: { userId: 'csv-user' } };
  });
});
describe('CSV account publication and grouping input boundary', () => {
  it('normalizes columns and types before writing, and publishes only after all saved inputs settle', async () => {
    const { records } = parseUserImportCsv(
      'Email,Name,email_verified\nperson@example.com,Alice,true',
      { skip_header: true }
    );
    const result = await processImportedRow(runtime, records[0], 2, options);
    expect(result.outcome).toBe('pending');
    expect(state.write.mock.calls[0][0].runtimeUser).toMatchObject({
      emailVerified: true,
      sensitiveValues: { email: 'person@example.com', name: 'Alice' },
    });
    expect(state.persist.mock.calls[0][0]).toMatchObject({
      db: accountCore,
      dbPii: accountPii,
      schemaDb: metadata,
    });
    expect(state.events).toEqual([
      'boundary-open',
      'canonical',
      'custom',
      'lifecycle',
      'boundary-close',
      'publish',
    ]);
  });
  it('resumes the same pinned row before duplicate handling and does not recreate the account', async () => {
    const record = { email: 'person@example.com' };
    await processImportedRow(runtime, record, 2, options);
    const first = state.publish.mock.calls[0][1];
    state.prior = true;
    state.pending = false;
    state.lookup.mockClear();
    expect(
      (await processImportedRow(runtime, record, 2, { ...options, on_duplicate: 'error' })).outcome
    ).toBe('created');
    expect(state.lookup).not.toHaveBeenCalled();
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.publish.mock.calls[1][1]).toMatchObject({
      candidateOperationId: first.candidateOperationId,
      idempotencyKey: first.idempotencyKey,
      requestHash: first.requestHash,
    });
  });
  it('uses the existing account shard for updates instead of the tenant metadata database', async () => {
    state.matches = [
      { legacyUserId: 'existing', coreBindingRef: 'ACCOUNT_CORE', piiBindingRef: 'ACCOUNT_PII' },
    ];
    const result = await processImportedRow(
      runtime,
      { email: 'person@example.com', name: 'Updated' },
      2,
      options
    );
    expect(result.outcome).toBe('updated');
    expect(state.sync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'existing', name: 'Updated' })
    );
    expect(state.events).toEqual(['boundary-open', 'update', 'boundary-close']);
    expect(state.publish).not.toHaveBeenCalled();
  });
  it('does not publish during validation and rejects ambiguous accounts', async () => {
    expect(
      (
        await processImportedRow(runtime, { email: 'person@example.com' }, 2, {
          ...options,
          validate_only: true,
        })
      ).outcome
    ).toBe('validated');
    expect(state.publish).not.toHaveBeenCalled();
    expect(state.events).toEqual([]);
    state.matches = [{}, {}];
    await expect(
      processImportedRow(runtime, { email: 'person@example.com' }, 2, options)
    ).rejects.toThrow('ambiguous');
  });

  describe('identity assurance of an imported account', () => {
    const withSettings = (store: Record<string, string>, failReads = false) =>
      ({
        ...runtime,
        env: {
          ...runtime.env,
          SETTINGS: {
            get: async (key: string) => {
              if (failReads) throw new Error('kv down');
              return store[key] ?? null;
            },
            put: async () => {},
            delete: async () => {},
            list: async () => ({ keys: [], list_complete: true }),
          },
        } as unknown as Env,
      }) as typeof runtime;
    const defaultIal = (level: string) => ({
      'settings:tenant:tenant-a:assurance': JSON.stringify({ 'assurance.default_ial': level }),
    });

    it('records the tenant default IAL as tenant-policy evidence when the row gives none', async () => {
      await processImportedRow(
        withSettings(defaultIal('IAL2')),
        { email: 'person@example.com' },
        2,
        options
      );

      expect(state.write.mock.calls[0][0].initialAssurance).toMatchObject({
        level: 'IAL2',
        evidenceType: 'tenant_policy',
        issuerRef: 'tenant_policy',
      });
    });

    it('records nothing at the default IAL1', async () => {
      await processImportedRow(withSettings({}), { email: 'person@example.com' }, 2, options);

      expect(state.write.mock.calls[0][0].initialAssurance ?? null).toBeNull();
    });

    it('records what the row asserts instead of the tenant default', async () => {
      await processImportedRow(
        withSettings(defaultIal('IAL3')),
        { email: 'person@example.com', ial: 'IAL2', ial_verified_at: '2026-09-01' },
        2,
        options
      );

      expect(state.write.mock.calls[0][0].initialAssurance).toEqual({
        level: 'IAL2',
        evidenceType: 'import',
        issuerRef: 'import:job-a',
        verifiedAt: Date.parse('2026-09-01T00:00:00Z'),
        contentId: { kind: 'import', parts: ['IAL2', Date.parse('2026-09-01T00:00:00Z')] },
      });
      // The columns are evidence, not custom attributes.
      expect(state.write.mock.calls[0][0].runtimeUser.sensitiveValues).not.toHaveProperty('ial');
    });

    it('refuses a row whose IAL is not valid, creating nothing', async () => {
      for (const validate_only of [false, true]) {
        await expect(
          processImportedRow(withSettings({}), { email: 'person@example.com', ial: 'IAL9' }, 2, {
            ...options,
            validate_only,
          })
        ).rejects.toThrow('Unsupported ial: IAL9');
      }
      expect(state.publish).not.toHaveBeenCalled();
    });

    it('replaces what earlier imports asserted for an existing account when the row gives an IAL', async () => {
      state.matches = [
        { legacyUserId: 'existing', coreBindingRef: 'ACCOUNT_CORE', piiBindingRef: 'ACCOUNT_PII' },
      ];

      await processImportedRow(runtime, { email: 'person@example.com', ial: 'IAL2' }, 2, options);

      expect(state.applyAssurance).toHaveBeenCalledWith(
        accountCore,
        'tenant-a',
        'existing',
        'job-a',
        expect.any(Number),
        { ial: 'IAL2', verifiedAt: null }
      );
      expect(state.events).toEqual(['boundary-open', 'update', 'boundary-close']);
    });

    it('keeps it when the row gives none', async () => {
      state.matches = [
        { legacyUserId: 'existing', coreBindingRef: 'ACCOUNT_CORE', piiBindingRef: 'ACCOUNT_PII' },
      ];

      await processImportedRow(runtime, { email: 'person@example.com' }, 2, options);

      expect(state.applyAssurance).toHaveBeenCalledWith(
        accountCore,
        'tenant-a',
        'existing',
        'job-a',
        expect.any(Number),
        null
      );
    });

    it('does not touch an existing account when the row is only validated', async () => {
      state.matches = [
        { legacyUserId: 'existing', coreBindingRef: 'ACCOUNT_CORE', piiBindingRef: 'ACCOUNT_PII' },
      ];

      await processImportedRow(runtime, { email: 'person@example.com', ial: 'IAL2' }, 2, {
        ...options,
        validate_only: true,
      });

      expect(state.applyAssurance).not.toHaveBeenCalled();
    });

    describe('when only the evidence of a new account cannot be recorded', () => {
      const record = { email: 'person@example.com' };
      const failOnce = () =>
        state.write.mockImplementationOnce(() => {
          throw new InitialAssuranceRecordError(new Error('d1 down'));
        });

      it('is a retryable step of the creation, not an ordinary failed row', async () => {
        failOnce();

        const failure = await processImportedRow(
          withSettings(defaultIal('IAL2')),
          record,
          2,
          options
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ImportAssuranceStepError);
        expect((failure as ImportAssuranceStepError).phase).toBe('create');
        expect(createFailureEntry(2, record, failure)).toMatchObject({
          row: 2,
          error_code: 'assurance_initial_failed',
          retryable: true,
        });
      });

      it('is tried again by the job a few times, then fails like any row', () => {
        const failure = new ImportAssuranceStepError(new Error('x'), 'create');
        expect([0, 1, 2, 3, 4, 5].map((n) => importRowErrorDisposition(failure, n))).toEqual([
          'retry',
          'retry',
          'retry',
          'retry',
          'fail',
          'fail',
        ]);
        // Other failures, and the update of an existing user, are not tried again by the job.
        expect(importRowErrorDisposition(new Error('bad'), 0)).toBe('fail');
        expect(importRowErrorDisposition(new ImportAssuranceStepError(new Error('x')), 0)).toBe(
          'fail'
        );
      });

      it('is completed when the same row is processed again: the unfinished creation is resumed and records the evidence', async () => {
        const settings = withSettings(defaultIal('IAL2'));
        failOnce();
        await expect(processImportedRow(settings, record, 2, options)).rejects.toBeInstanceOf(
          ImportAssuranceStepError
        );
        const first = state.publish.mock.calls[0][1];

        // The creation operation of the row exists (`writing`): the row finds it before anything
        // else, and writes the creation again, with the same evidence.
        state.prior = true;
        state.resumeWrites = true;
        state.lookup.mockClear();
        const again = await processImportedRow(settings, record, 2, options);

        expect(again.outcome).toBe('pending');
        expect(state.lookup).not.toHaveBeenCalled();
        expect(state.publish.mock.calls[1][1]).toMatchObject({
          candidateOperationId: first.candidateOperationId,
          idempotencyKey: first.idempotencyKey,
          requestHash: first.requestHash,
        });
        expect(state.write).toHaveBeenCalledTimes(2);
        expect(state.write.mock.calls[1][0].initialAssurance).toMatchObject({
          level: 'IAL2',
          evidenceType: 'tenant_policy',
        });
      });

      it('waits for the default when it cannot be read while an unfinished creation is resumed', async () => {
        state.prior = true;
        state.resumeWrites = true;

        const failure = await processImportedRow(withSettings({}, true), record, 2, options).catch(
          (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(ImportAssuranceStepError);
        expect((failure as ImportAssuranceStepError).phase).toBe('create');
        expect(state.write).not.toHaveBeenCalled();
      });
    });

    describe('with the evidence in a real store', () => {
      const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
      type SqlValue = string | number | null;
      const values = (params: unknown[] = []) =>
        params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));
      let db: DatabaseSync;
      let failBatches = 0;
      const row = { email: 'person@example.com', ial: 'IAL3', ial_verified_at: '2026-09-01' };
      const update = () => {
        state.matches = [
          {
            legacyUserId: 'existing',
            coreBindingRef: 'ACCOUNT_CORE',
            piiBindingRef: 'ACCOUNT_PII',
          },
        ];
        return processImportedRow(runtime, row, 7, options);
      };
      const active = () =>
        db
          .prepare(
            `SELECT evidence_type, issuer_ref, assurance_level FROM assurance_evidence WHERE revoked_at IS NULL`
          )
          .all();

      beforeEach(() => {
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
           ) VALUES ('account-a', 'tenant-a', 'person', 'active', 'existing', 'subject-a', 100, 100);
           INSERT INTO assurance_evidence (
             id, tenant_id, subject_id, evidence_type, issuer_ref, assurance_framework,
             assurance_level, verified_at, created_at, updated_at
           ) VALUES ('earlier', 'tenant-a', 'subject-a', 'import', 'import:job-0', 'nist_800_63',
                     'IAL2', 1000, 1, 1)`
        );
        failBatches = 0;
        const run = (sql: string, params?: unknown[]) => ({
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
        });
        state.store = {
          query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
          queryOne: async (sql: string, params?: unknown[]) =>
            db.prepare(sql).get(...values(params)) ?? null,
          execute: async (sql: string, params?: unknown[]) => run(sql, params),
          batch: async (statements: Array<{ sql: string; params?: unknown[] }>) => {
            if (failBatches > 0) {
              failBatches -= 1;
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
        };
      });
      afterEach(() => {
        state.store = null;
        db.close();
      });

      it('replaces what an earlier import asserted, once the user is written', async () => {
        expect((await update()).outcome).toBe('updated');

        expect(active()).toEqual([
          { evidence_type: 'import', issuer_ref: 'import:job-a', assurance_level: 'IAL3' },
        ]);
      });

      it('changes no evidence when the user cannot be written', async () => {
        state.sync.mockRejectedValueOnce(new Error('user write failed'));

        await expect(update()).rejects.toThrow('user write failed');

        expect(active()).toEqual([
          { evidence_type: 'import', issuer_ref: 'import:job-0', assurance_level: 'IAL2' },
        ]);
        expect(state.applyAssurance).not.toHaveBeenCalled();
      });

      it('fails the row, retryable, when the evidence cannot be written after the user was, and importing it again completes it', async () => {
        failBatches = 1;

        const failure = await update().catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ImportAssuranceStepError);
        expect(createFailureEntry(7, row, failure)).toMatchObject({
          row: 7,
          error_code: 'assurance_update_failed',
          retryable: true,
        });
        // The user was written; the evidence is as it was.
        expect(state.sync).toHaveBeenCalledTimes(1);
        expect(active()).toMatchObject([{ issuer_ref: 'import:job-0' }]);

        expect((await update()).outcome).toBe('updated');
        expect(active()).toEqual([
          { evidence_type: 'import', issuer_ref: 'import:job-a', assurance_level: 'IAL3' },
        ]);
      });

      it('does not bring back evidence revoked since when the same row is processed again', async () => {
        await update();
        db.prepare(
          `UPDATE assurance_evidence SET revoked_at = 9, revoked_by = 'admin:a' WHERE revoked_at IS NULL`
        ).run();

        await update();

        expect(active()).toEqual([]);
      });
    });

    describe('with a custom attribute named like an assurance column', () => {
      const collidingRuntime = (names: string[], fail = false) =>
        ({
          ...runtime,
          metadata: {
            ...metadata,
            query: async () => {
              if (fail) throw new Error('d1 down');
              return names.map((field_key) => ({ field_key }));
            },
          },
        }) as unknown as typeof runtime;

      it.each([false, true])(
        'fails the row, creating and changing nothing (validate only: %s)',
        async (validate_only) => {
          await expect(
            processImportedRow(
              collidingRuntime(['ial']),
              { email: 'person@example.com', ial: 'IAL3' },
              2,
              { ...options, validate_only }
            )
          ).rejects.toThrow('custom attribute named ial');
          expect(state.publish).not.toHaveBeenCalled();
          expect(state.write).not.toHaveBeenCalled();
          expect(state.sync).not.toHaveBeenCalled();
        }
      );

      it('does not take an unreadable list of attributes for none', async () => {
        await expect(
          processImportedRow(
            collidingRuntime([], true),
            { email: 'person@example.com', ial: 'IAL3' },
            2,
            options
          )
        ).rejects.toThrow('d1 down');
        expect(state.publish).not.toHaveBeenCalled();
      });

      it('leaves files without the columns alone', async () => {
        await processImportedRow(
          collidingRuntime(['ial'], true),
          { email: 'person@example.com' },
          2,
          options
        );
        expect(state.publish).toHaveBeenCalled();
      });
    });

    it('fails the row, creating nothing, when the default IAL cannot be read', async () => {
      await expect(
        processImportedRow(withSettings({}, true), { email: 'person@example.com' }, 2, options)
      ).rejects.toBeInstanceOf(DefaultIALUnavailableError);
      expect(state.publish).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
    });

    it('reports such a row as retryable, apart from a row that is wrong', () => {
      expect(
        createFailureEntry(3, { email: 'a@example.com' }, new DefaultIALUnavailableError())
      ).toMatchObject({
        row: 3,
        error_code: 'default_ial_unavailable',
        retryable: true,
      });
      expect(createFailureEntry(3, { email: 'a@example.com' }, new Error('bad'))).toMatchObject({
        error_code: 'import_row_failed',
      });
    });
  });
});
