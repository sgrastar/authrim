import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CloudflareD1Database,
  CloudflareD1Query,
  CloudflareD1QueryResult,
} from '../../packages/ar-lib-core/src/services/control-plane/index.js';
import {
  buildPhase0bAccountSteps,
  buildPhase0bNames,
  buildPhase0bSeedBatches,
  parsePhase0bArgs,
  runPhase0bCapacity,
  summarizePhase0bMeasurements,
} from './phase0b-d1-capacity.js';

describe('Phase 0b D1 capacity harness', () => {
  it('uses required 10k and 100k points followed by bounded geometric steps', () => {
    expect(buildPhase0bAccountSteps(200_000)).toEqual([10_000, 100_000, 200_000]);
    expect(buildPhase0bAccountSteps(800_000)).toEqual([10_000, 100_000, 200_000, 400_000, 800_000]);
    expect(() => buildPhase0bAccountSteps(100_000)).toThrow('invalid_phase0b_max_accounts');
    expect(() => buildPhase0bAccountSteps(300_000)).toThrow(
      'phase0b_max_accounts_must_be_geometric_step'
    );
    expect(() => buildPhase0bAccountSteps(20_000_000)).toThrow('invalid_phase0b_max_accounts');
  });

  it('is dry-run by default and restricts destructive execution to test with confirmation', () => {
    expect(parsePhase0bArgs(['--env', 'test'])).toMatchObject({
      env: 'test',
      execute: false,
      confirmDisposable: false,
      maxAccounts: 200_000,
    });
    expect(() => parsePhase0bArgs(['--env', 'conformance', '--execute'])).toThrow(
      'phase0b_test_environment_required'
    );
    expect(() => parsePhase0bArgs(['--env', 'test', '--execute'])).toThrow(
      'phase0b_disposable_confirmation_required'
    );
    expect(parsePhase0bArgs(['--env', 'test', '--execute', '--confirm-disposable'])).toMatchObject({
      execute: true,
      confirmDisposable: true,
    });
    expect(() => parsePhase0bArgs(['--env', 'test', '--max-accounts', '300000'])).toThrow(
      'phase0b_max_accounts_must_be_geometric_step'
    );
    expect(() => parsePhase0bArgs(['--env', 'test', '--primary-location-hint', 'moon'])).toThrow(
      'invalid_phase0b_primary_location_hint'
    );
  });

  it('generates unmistakable disposable database names', () => {
    const names = buildPhase0bNames(
      new Date('2026-07-29T01:02:03.000Z'),
      'abcdef00-0000-0000-0000-000000000000'
    );
    expect(names).toEqual({
      suffix: '20260729010203-abcdef',
      core: 'authrim-phase0b-capacity-test-20260729010203-abcdef-core',
      pii: 'authrim-phase0b-capacity-test-20260729010203-abcdef-pii',
      lookup: 'authrim-phase0b-capacity-test-20260729010203-abcdef-lookup',
    });
  });

  it('bounds seed chunks and covers account, subject, credential, PII, and routing rows', () => {
    const batches = buildPhase0bSeedBatches(0, 5_000);
    expect(batches.core).toHaveLength(4);
    expect(batches.pii).toHaveLength(3);
    expect(batches.lookup).toHaveLength(3);
    expect(batches.core.map((query) => query.sql).join('\n')).toMatch(/identity_subjects/u);
    expect(batches.core.map((query) => query.sql).join('\n')).toMatch(/identity_accounts/u);
    expect(batches.core.map((query) => query.sql).join('\n')).toMatch(/totp_credentials/u);
    expect(batches.pii.map((query) => query.sql).join('\n')).toMatch(/users_pii/u);
    expect(batches.lookup.map((query) => query.sql).join('\n')).toMatch(/lookup_identifiers/u);
    expect(batches.lookup.map((query) => query.sql).join('\n')).not.toContain('@benchmark.invalid');
    expect(() => buildPhase0bSeedBatches(0, 5_001)).toThrow('invalid_phase0b_seed_range');
    expect(() => buildPhase0bSeedBatches(10, 10)).toThrow('invalid_phase0b_seed_range');
  });

  it('calculates nearest-rank percentiles, errors, and D1 row metadata', () => {
    const metric = summarizePhase0bMeasurements([
      {
        durationMs: 10,
        results: [{ success: true, meta: { rows_read: 1, rows_written: 2 } }],
      },
      {
        durationMs: 30,
        results: [{ success: true, meta: { rows_read: 3, rows_written: 4 } }],
      },
      { durationMs: 20, error: 'query_failed' },
    ]);
    expect(metric).toEqual({
      attempts: 3,
      errors: 1,
      errorRate: 1 / 3,
      p50Ms: 20,
      p95Ms: 30,
      p99Ms: 30,
      rowsRead: 4,
      rowsWritten: 6,
    });
  });

  it('writes a credential-free dry-run plan without contacting Cloudflare', async () => {
    const outputDir = resolve(tmpdir(), `authrim-phase0b-${crypto.randomUUID()}`);
    try {
      const options = parsePhase0bArgs(['--env', 'test', '--output-dir', outputDir]);
      const result = await runPhase0bCapacity(options, {});
      const persisted = JSON.parse(await readFile(result.evidencePath, 'utf8')) as {
        mode: string;
        plannedAccountSteps: number[];
        calibration: Record<string, unknown>;
      };
      expect(persisted.mode).toBe('dry-run');
      expect(persisted.plannedAccountSteps).toEqual([10_000, 100_000, 200_000]);
      expect(persisted.calibration).toMatchObject({
        targetAccountCount: null,
        requiresLiveResultReview: true,
        highestMeasuredAccountCount: null,
      });
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('runs the current three migration streams through every step and cleans all databases', async () => {
    const outputDir = resolve(tmpdir(), `authrim-phase0b-live-${crypto.randomUUID()}`);
    const databases: CloudflareD1Database[] = [];
    const deleted: string[] = [];
    const successful = (count = 1): CloudflareD1QueryResult[] =>
      Array.from({ length: count }, () => ({
        success: true,
        results: [{ ok: true }],
        meta: { rows_read: 1, rows_written: 1 },
      }));
    const client = {
      async listD1Databases() {
        return [...databases];
      },
      async createD1Database(input: { name: string }) {
        const database = { uuid: `db-${databases.length + 1}`, name: input.name };
        databases.push(database);
        return database;
      },
      async deleteD1Database(databaseId: string) {
        deleted.push(databaseId);
      },
      async getD1Database(databaseId: string) {
        const database = databases.find((candidate) => candidate.uuid === databaseId);
        if (!database) throw new Error('missing_test_database');
        return { ...database, file_size: 1_000_000 };
      },
      async queryD1(_databaseId: string, _sql: string, _params?: unknown[]) {
        return successful();
      },
      async queryD1Batch(_databaseId: string, batch: readonly CloudflareD1Query[]) {
        return successful(batch.length);
      },
    };
    try {
      const options = parsePhase0bArgs([
        '--env',
        'test',
        '--execute',
        '--confirm-disposable',
        '--output-dir',
        outputDir,
      ]);
      const result = await runPhase0bCapacity(
        options,
        { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) },
        client
      );
      expect(result.evidence.manifestProductVersion).toBe('0.4.0');
      expect(result.evidence.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.evidence.measurements.map((entry) => entry.accountCount)).toEqual([
        10_000, 100_000, 200_000,
      ]);
      expect(result.evidence.calibration.highestMeasuredAccountCount).toBe(200_000);
      expect(deleted.sort()).toEqual(['db-1', 'db-2', 'db-3']);
      expect(result.evidence.cleanup).toHaveLength(3);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it('recovers a created database by deterministic name after response loss and deletes it', async () => {
    const outputDir = resolve(tmpdir(), `authrim-phase0b-loss-${crypto.randomUUID()}`);
    const databases: CloudflareD1Database[] = [];
    const deleted: string[] = [];
    const client = {
      async listD1Databases() {
        return [...databases];
      },
      async createD1Database(input: { name: string }) {
        databases.push({ uuid: 'response-lost-db', name: input.name });
        throw new Error('simulated_response_loss');
      },
      async deleteD1Database(databaseId: string) {
        deleted.push(databaseId);
      },
      async getD1Database() {
        throw new Error('unexpected_get');
      },
      async queryD1() {
        throw new Error('unexpected_query');
      },
      async queryD1Batch() {
        throw new Error('unexpected_batch');
      },
    };
    try {
      const options = parsePhase0bArgs([
        '--env',
        'test',
        '--execute',
        '--confirm-disposable',
        '--output-dir',
        outputDir,
      ]);
      await expect(
        runPhase0bCapacity(options, { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }, client)
      ).rejects.toThrow('phase0b_capacity_failed:simulated_response_loss');
      expect(deleted).toEqual(['response-lost-db']);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
