import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { auditResults } from './r2-audit.mjs';

const firstFile = 'r2-probes-100-1-1000.ndjson';
const retryFile = 'r2-probes-100-1-2000.ndjson';
const nextFile = 'r2-probes-100-2-3000.ndjson';
const accountId = '0123456789abcdef0123456789abcdef';
const uuid = '11111111-2222-3333-4444-555555555555';
const token = 'do-not-publish-this-private-token';

function sample(
  target,
  operation,
  start,
  { ok = true, timeout = false, colo = 'NRT', duration = 10, phase } = {}
) {
  return {
    target,
    operation,
    ...(phase === undefined ? {} : { phase }),
    startedMs: start,
    finishedMs: start + duration,
    elapsedMs: duration,
    ok,
    timeout,
    colo,
    sqlWallMs: duration / 2,
    meta: { served_by_colo: 'HKG', served_by_region: 'APAC', token },
    error: `${token} ${uuid} ${accountId}`,
  };
}
function fixture() {
  const results = {
    runId: 'authrim-r2b-test',
    completedAt: '2026-10-17T00:00:00.000Z',
    measurements: [
      {
        targetMiB: 100,
        repeat: 1,
        verified: true,
        probeFiles: [firstFile, firstFile],
        backupFinishedAtMs: 2000,
        restorePreparationMs: 500,
        recoveryTimingMode: 'sum completed provisioning/import/verification stages after resume',
        probes: { backupPrepare: {}, recovery: { 'control/read': { requests: 1, failures: 0 } } },
      },
    ],
  };
  const journal = {
    runId: results.runId,
    accountId,
    token,
    workerUrl: 'https://private-worker.example.invalid',
    databases: [
      { uuid, deleted: true },
      { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', deleted: true },
    ],
    measurements: [{ targetMiB: 100, repeat: 1, probeFiles: [firstFile, retryFile] }],
    objects: [
      { key: 'raw.sql', deleted: true },
      { key: 'raw.sql', deleted: true },
      { key: 'parts.sql', deleted: true },
    ],
    bucket: { name: 'private-bucket', deleted: true },
    workerDeleted: true,
    cleanedUpAt: '2026-10-17T00:01:00.000Z',
  };
  const duplicate = sample('control', 'read', 1000, { ok: false });
  const files = new Map([
    [
      firstFile,
      [
        duplicate,
        sample('control', 'write', 1100, { ok: false, timeout: true }),
        sample('source', 'read', 1200, { ok: false }),
      ],
    ],
    [
      retryFile,
      [
        duplicate,
        sample('control', 'read', 1495, { duration: 10 }),
        sample('control', 'read', 1600),
        sample('control', 'write', 1700),
        sample('control', 'write', 2100),
      ],
    ],
  ]);
  return { results, journal, files };
}
const reader =
  (files, calls = []) =>
  async (name) => {
    calls.push(name);
    if (!files.has(name)) throw new Error('missing private file');
    return `${files
      .get(name)
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`;
  };

test('deduplicates files and requests while retaining failed retries and inferring final preparation coverage', async () => {
  const { results, journal, files } = fixture();
  const originalResults = structuredClone(results);
  const originalJournal = structuredClone(journal);
  const calls = [];
  const audited = await auditResults(results, journal, reader(files, calls));
  assert.deepEqual(calls, [firstFile, retryFile]);
  assert.deepEqual(results, originalResults);
  assert.deepEqual(journal, originalJournal);
  const measurement = audited.measurements[0];
  assert.equal(measurement.probeCoverage.probeFilesRead, 2);
  assert.equal(measurement.probeCoverage.duplicateSamplesRemoved, 1);
  assert.equal(measurement.allTrialsProbes['control/read'].requests, 3);
  assert.equal(measurement.allTrialsProbes['control/read'].failures, 1);
  assert.equal(measurement.allTrialsProbes['control/write'].requests, 3);
  assert.equal(measurement.allTrialsProbes['control/write'].failures, 1);
  assert.equal(measurement.allTrialsProbes['control/write'].timeouts, 1);
  assert.equal(measurement.probeCoverage.backupPrepare.inferred, true);
  assert.equal(measurement.probeCoverage.backupPrepare.startedAtMs, 1500);
  assert.equal(measurement.probes.backupPrepare['control/read'].requests, 2);
  assert.equal(measurement.probes.backupPrepare['control/write'].requests, 1);
  assert.equal(measurement.probeCoverage.recovery.continuousEndToEndCoverage, false);
  assert.match(measurement.probeCoverage.recovery.scope, /final resumed verification only/);
  assert.deepEqual(measurement.probes.recovery, originalResults.measurements[0].probes.recovery);
  assert.equal(audited.probeAudit.controlRead.failures, 1);
  assert.equal(audited.probeAudit.controlWrite.failures, 1);
  assert.deepEqual(audited.probeAudit.workerColos, ['NRT']);
  assert.deepEqual(audited.probeAudit.d1Colos, ['HKG']);
  assert.deepEqual(audited.probeAudit.d1Regions, ['APAC']);
  assert.deepEqual(audited.cleanupSummary, {
    dbsCreated: 2,
    dbsDeleted: 2,
    bucketDeleted: true,
    workerDeleted: true,
    objectKeysDeleted: 2,
    objectKeysDeletedScope:
      'Journal-tracked keys whose deletion requests succeeded, including predeclared unused placeholders; not a count of objects confirmed to have existed.',
    completedAt: journal.cleanedUpAt,
  });
  const serialized = JSON.stringify(audited);
  for (const privateValue of [accountId, uuid, token, 'private-bucket', journal.workerUrl]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test('partial import resume distinguishes tail imports and preparation from verification-only recovery', async () => {
  const { results, journal, files } = fixture();
  const measurement = results.measurements[0];
  measurement.importTimingMode = 'sum successful part stages after resume';
  measurement.restoreTailPreparation = { parts: [] };
  measurement.resumeWorkerDeployMs = 100;
  files
    .get(firstFile)
    .push(
      sample('control', 'read', 2200, { phase: 'recoveryPrepare', ok: false }),
      sample('source', 'read', 2250, { phase: 'recoveryPrepare', ok: false })
    );
  files
    .get(retryFile)
    .push(
      sample('control', 'read', 2300, { phase: 'recoveryPrepare' }),
      sample('control', 'write', 2400, { phase: 'recovery' })
    );
  const originalRecovery = structuredClone(measurement.probes.recovery);
  const audited = await auditResults(results, journal, reader(files));
  const actual = audited.measurements[0];
  assert.match(actual.probeCoverage.recovery.scope, /remaining tail imports and verification/);
  assert.doesNotMatch(actual.probeCoverage.recovery.scope, /verification only/);
  assert.equal(actual.probeCoverage.recovery.continuousEndToEndCoverage, false);
  assert.deepEqual(actual.probes.recovery, originalRecovery);
  assert.match(actual.probeCoverage.recoveryPrepare.scope, /including failed attempts and retries/);
  assert.equal(actual.probeCoverage.recoveryPrepare.inferred, false);
  assert.equal(actual.probeCoverage.recoveryPrepare.available, true);
  assert.equal(actual.probeCoverage.recoveryPrepare.uniqueSamples, 3);
  assert.deepEqual(actual.probeCoverage.recoveryPrepare.observedWindow, {
    startedAtMs: 2200,
    finishedAtMs: 2310,
  });
  assert.deepEqual(actual.probeCoverage.recoveryPrepare.missingControlSeries, ['control/write']);
  assert.equal(actual.allTrialsProbesByPhase.recoveryPrepare['control/read'].requests, 2);
  assert.equal(actual.allTrialsProbesByPhase.recoveryPrepare['control/read'].failures, 1);
  assert.equal(actual.allTrialsProbesByPhase.recoveryPrepare['source/read'].failures, 1);
  assert.deepEqual(actual.probes.recoveryPrepare, actual.allTrialsProbesByPhase.recoveryPrepare);
  assert.equal(audited.probeAudit.recoveryPrepare.controlRead.requests, 2);
  assert.equal(audited.probeAudit.recoveryPrepare.controlRead.failures, 1);
  assert.equal(audited.probeAudit.recoveryPrepare.controlWrite.requests, 0);
  assert.deepEqual(audited.probeAudit.recoveryPrepare.missingControlSeries, ['control/write']);
  assert.equal(audited.probeAudit.controlRead.failures, 2);
});

test('a repeated audit preserves inferred preparation boundaries and records missing phase coverage', async () => {
  const { results, journal, files } = fixture();
  const first = await auditResults(results, journal, reader(files));
  const second = await auditResults(first, journal, reader(files));
  assert.deepEqual(second, first);
  const actual = second.measurements[0];
  assert.equal(actual.probeCoverage.backupPrepare.inferred, true);
  assert.equal(actual.probeCoverage.samplesWithoutRecordedPhase, 7);
  assert.equal(actual.probeCoverage.recoveryPrepare.available, false);
  assert.deepEqual(actual.probeCoverage.recoveryPrepare.observedWindow, {
    startedAtMs: null,
    finishedAtMs: null,
  });
  assert.deepEqual(actual.probeCoverage.recoveryPrepare.missingControlSeries, [
    'control/read',
    'control/write',
  ]);
  assert.equal(second.probeAudit.recoveryPrepare.controlRead.requests, 0);
  assert.equal(second.probeAudit.recoveryPrepare.controlWrite.requests, 0);
  assert.match(second.cleanupSummary.objectKeysDeletedScope, /predeclared unused placeholders/);
});

test('global controls include failures from every measurement rather than the final successful trial only', async () => {
  const { results, journal, files } = fixture();
  results.measurements.push({
    targetMiB: 100,
    repeat: 2,
    verified: true,
    probeFiles: [nextFile],
    recoveryTimingMode: 'continuous wall clock',
    probes: { backupPrepare: { 'control/read': { requests: 2, failures: 0 } } },
  });
  files.set(nextFile, [
    sample('control', 'read', 3000, { ok: false, colo: 'KIX' }),
    sample('control', 'write', 3100),
  ]);
  const audited = await auditResults(results, journal, reader(files));
  assert.equal(audited.probeAudit.controlRead.requests, 4);
  assert.equal(audited.probeAudit.controlRead.failures, 2);
  assert.equal(audited.probeAudit.controlWrite.requests, 4);
  assert.equal(audited.probeAudit.controlWrite.failures, 1);
  assert.deepEqual(audited.probeAudit.workerColos, ['KIX', 'NRT']);
  assert.equal(audited.measurements[1].probeCoverage.backupPrepare.inferred, false);
  assert.deepEqual(
    audited.measurements[1].probes.backupPrepare,
    results.measurements[1].probes.backupPrepare
  );
});

test('rejects traversal, wrong measurement filenames, and absent or malformed probe data', async () => {
  for (const unsafe of [
    '../resources.json',
    '/tmp/private.ndjson',
    `nested/${firstFile}`,
    'r2-probes-100-2-1000.ndjson',
  ]) {
    const { results, journal, files } = fixture();
    results.measurements[0].probeFiles = [unsafe];
    await assert.rejects(
      auditResults(results, journal, reader(files)),
      /Unsafe probe filename|different measurement/
    );
  }
  const { results, journal, files } = fixture();
  files.delete(retryFile);
  await assert.rejects(auditResults(results, journal, reader(files)), /could not be read/);
  await assert.rejects(
    auditResults(results, journal, async () => ''),
    /no complete records/
  );
  await assert.rejects(
    auditResults(results, journal, async () => '{invalid}\n'),
    /Invalid probe JSON/
  );
  await assert.rejects(
    auditResults(results, journal, async () =>
      JSON.stringify({ target: 'control', operation: 'read' })
    ),
    /success state is missing/
  );
  results.measurements[0].probeFiles = [];
  journal.measurements[0].probeFiles = [];
  await assert.rejects(auditResults(results, journal, reader(files)), /no recorded probe files/);
});

test('missing preparation timing is explicit and incomplete cleanup is not presented as complete', async () => {
  const { results, journal, files } = fixture();
  delete results.measurements[0].backupFinishedAtMs;
  delete results.measurements[0].restorePreparationMs;
  journal.databases[0].deleted = false;
  journal.bucket.deleted = false;
  delete journal.cleanedUpAt;
  const audited = await auditResults(results, journal, reader(files));
  assert.equal(audited.measurements[0].probeCoverage.backupPrepare.available, false);
  assert.match(audited.measurements[0].probeCoverage.backupPrepare.reason, /unavailable/);
  assert.equal(audited.cleanupSummary.dbsDeleted, 1);
  assert.equal(audited.cleanupSummary.bucketDeleted, false);
  assert.equal(audited.cleanupSummary.completedAt, null);
});

test('redacts private identifiers and credential fields without removing useful token-family counts', async () => {
  const { results, journal, files } = fixture();
  results.token = token;
  results.notes = `private ${accountId} database ${uuid} Bearer unrelated-private-credential`;
  results.measurements[0].counts = { user_token_families: 16 };
  const audited = await auditResults(results, journal, reader(files));
  assert.equal('token' in audited, false);
  assert.equal(audited.notes.includes(accountId), false);
  assert.equal(audited.notes.includes(uuid), false);
  assert.equal(audited.notes.includes('unrelated-private-credential'), false);
  assert.equal(audited.measurements[0].counts.user_token_families, 16);
});

test('CLI requires an explicit output and rejects writes outside the benchmark root', () => {
  const script = fileURLToPath(new URL('./r2-audit.mjs', import.meta.url));
  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage:/);
  const escaped = spawnSync(
    process.execPath,
    [
      script,
      '--input-results',
      '/tmp/result.json',
      '--run-dir',
      '/tmp',
      '--output-results',
      '/tmp/output.json',
    ],
    { encoding: 'utf8' }
  );
  assert.equal(escaped.status, 1);
  assert.match(escaped.stderr, /benchmark directory/);
});
