import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ScheduledIcebergWriter,
  logArchivePhysicalFingerprint,
} from '@authrim/ar-lib-logging/iceberg';
import {
  MemoryJournal,
  pipelineMetadata,
  LOCATION,
} from '../../../../ar-lib-logging/src/iceberg/__tests__/fixtures';
import {
  probeLogIcebergReadiness,
  type LogIcebergReadinessAttempt,
} from '../log-iceberg-readiness';
import { consumeLogIcebergMessage } from '../log-iceberg-runtime';
import { emitLogIcebergRow } from '../log-iceberg-emitter';
import { logProducerFixture } from './log-iceberg-producer-fixture';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((fn) => fn()));
async function fixture(mode: 'scheduled' | 'pipeline') {
  const f = await logProducerFixture(mode);
  Object.assign(f.env, {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    AUTHRIM_WORKER_SCRIPT_NAME: 'test-ar-management',
  });
  Object.assign(f.env.CONTROL ?? {}, {
    acquireEnvironmentBackupMutationPermit: async () => ({ admitted: true }),
    completeEnvironmentBackupMutationPermit: async () => {},
  });
  close.push(f.close);
  f.config.generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  f.env.AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION = f.config.generation;
  if (mode === 'pipeline') {
    f.catalog.metadata = pipelineMetadata();
    f.config.physicalFingerprint = await logArchivePhysicalFingerprint(f.catalog.metadata);
    f.env.AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT = f.config.physicalFingerprint;
  }
  const writer = f.env.LOG_ARCHIVE_WRITER;
  if (!writer) throw new Error('missing writer');
  const attempt: LogIcebergReadinessAttempt = {
    attemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    startedAt: new Date(f.now).toISOString(),
    deploymentFingerprint: 'dd'.repeat(32),
  };
  const ports = { admin: f.adapter, writer, catalog: f.catalog, store: () => f.store };
  return { ...f, attempt, ports, probe: () => probeLogIcebergReadiness(f.env, attempt, ports) };
}
describe('real non-PII post-deploy archive probe', () => {
  it('exports only the owned scheduled probe and proves Parquet/read/crypto without moving other eligible logs', async () => {
    const f = await fixture('scheduled');
    await emitLogIcebergRow(f.env, {
      tenantId: 'tenant-a',
      sourceDataset: 'core.event_log',
      logType: 'audit',
      eventAt: f.now - 8 * 86400000,
      ingestedAt: f.now - 8 * 86400000,
      expiresAt: null,
      row: { id: 'ordinary-event', tenant_id: 'tenant-a', action: 'user.login' },
    });
    const proof = await f.probe();
    expect(proof).toMatchObject({
      state: 'ready',
      mode: 'scheduled',
      attemptId: f.attempt.attemptId,
      startedAt: f.attempt.startedAt,
      generation: f.config.generation,
      keyVersion: 1,
      tableUuid: f.config.tableUuid,
      physicalFingerprint: f.config.physicalFingerprint,
    });
    expect(proof.snapshotId).not.toBeNull();
    expect(f.db.prepare('SELECT event_id FROM log_iceberg_records').all()).toMatchObject([
      { event_id: 'ordinary-event' },
    ]);
    const commits = f.catalog.commitCount;
    expect(await f.probe()).toMatchObject({
      state: 'ready',
      eventId: proof.eventId,
      snapshotId: proof.snapshotId,
    });
    expect(f.catalog.commitCount).toBe(commits);
  });
  it('does not confuse Pipeline acceptance with visibility and proves the later exact snapshot', async () => {
    const f = await fixture('pipeline');
    expect(await f.probe()).toMatchObject({ state: 'pending', snapshotId: null });
    expect(f.queueMessages).toHaveLength(1);
    await consumeLogIcebergMessage(f.queueMessages[0], f.env, f.now);
    expect(f.streamRecords).toHaveLength(1);
    expect(await f.probe()).toMatchObject({ state: 'pending', snapshotId: null });
    expect(f.queueMessages).toHaveLength(1);
    await new ScheduledIcebergWriter({
      catalog: f.catalog,
      store: f.store,
      journal: new MemoryJournal(),
      storageGeneration: f.config.generation,
      tableLocation: LOCATION,
    }).appendBatch({ batchId: 'provider-probe', fence: 'fence-1', records: f.streamRecords });
    expect(await f.probe()).toMatchObject({
      state: 'ready',
      attemptId: f.attempt.attemptId,
      keyVersion: 1,
    });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
  });
  it('requires a fresh attempt after deployment rather than accepting an older visible probe', async () => {
    const f = await fixture('pipeline');
    await f.probe();
    await consumeLogIcebergMessage(f.queueMessages[0], f.env, f.now);
    await new ScheduledIcebergWriter({
      catalog: f.catalog,
      store: f.store,
      journal: new MemoryJournal(),
      storageGeneration: f.config.generation,
      tableLocation: LOCATION,
    }).appendBatch({ batchId: 'old-provider-probe', fence: 'fence-1', records: f.streamRecords });
    expect((await f.probe()).state).toBe('ready');
    const next = {
      ...f.attempt,
      attemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      deploymentFingerprint: 'ee'.repeat(32),
    };
    expect(await probeLogIcebergReadiness(f.env, next, f.ports)).toMatchObject({
      state: 'pending',
      attemptId: next.attemptId,
    });
    expect(f.queueMessages).toHaveLength(2);
  });
});
