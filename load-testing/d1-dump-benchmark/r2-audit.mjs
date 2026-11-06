import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeProbes } from './metrics.mjs';

const scope =
  'All recorded probe files, including failed attempts and retries; observed requests only.';
const phases = ['baseline', 'export', 'backupCopy', 'backupPrepare', 'recoveryPrepare', 'recovery'];
const preparationScope =
  'All recorded requests labelled recoveryPrepare at request start, including failed attempts and retries; separate from the final recovery interval.';
const cleanupKeyScope =
  'Journal-tracked keys whose deletion requests succeeded, including predeclared unused placeholders; not a count of objects confirmed to have existed.';
const sensitiveKey =
  /^(?:accountId|account_id|databaseId|database_id|uuid|token|oauth_token|access_token|refresh_token|secret|BENCH_TOKEN|workerSecret|benchToken|authorization|signedUrl|signed_url|uploadUrl|upload_url|workerUrl|worker_url)$/i;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const emptySeries = () => ({
  requests: 0,
  failures: 0,
  timeouts: 0,
  p50Ms: null,
  p95Ms: null,
  maxMs: null,
  maxSqlWallMs: null,
  colos: [],
});

/** Pure apart from the supplied read callback. Never mutates results or journal. */
export async function auditResults(results, journal, readProbeFile) {
  assert.ok(results && Array.isArray(results.measurements), 'Expected results.measurements.');
  assert.ok(journal && Array.isArray(journal.databases), 'Expected the resource journal.');
  assert.equal(typeof readProbeFile, 'function');
  if (results.runId !== undefined && journal.runId !== undefined) {
    assert.equal(results.runId, journal.runId, 'Results and journal refer to different runs.');
  }
  const output = structuredClone(results);
  const journalMeasurements = new Map(
    (journal.measurements ?? []).map((m) => [measurementKey(m), m])
  );
  const files = new Map();
  const overall = new Map();
  const seenMeasurements = new Set();
  for (const measurement of output.measurements) {
    const key = measurementKey(measurement);
    assert.ok(!seenMeasurements.has(key), 'Duplicate measurement identity.');
    seenMeasurements.add(key);
    const recorded = journalMeasurements.get(key);
    const references = [measurement.probeFiles, recorded?.probeFiles].filter(
      (value) => value !== undefined
    );
    assert.ok(references.every(Array.isArray), 'probeFiles must be an array.');
    const names = [...new Set(references.flat())];
    assert.ok(names.length > 0, 'Measurement has no recorded probe files.');
    for (const name of names) validateProbeName(name, measurement);
    const records = [];
    for (const name of names) {
      if (!files.has(name)) {
        let contents;
        try {
          contents = await readProbeFile(name);
        } catch {
          throw new Error(`Recorded probe file could not be read: ${name}`);
        }
        files.set(name, parseProbes(contents, name));
      }
      records.push(...files.get(name));
    }
    const unique = new Map();
    for (const sample of records) {
      const identity = sampleIdentity(sample);
      unique.set(identity, sample);
      overall.set(identity, sample);
    }
    const samples = [...unique.values()];
    assert.ok(samples.length > 0, 'Measurement probe files contain no complete records.');
    const inferBackupPrepare =
      !hasSeries(measurement.probes?.backupPrepare) ||
      measurement.probeCoverage?.backupPrepare?.inferred === true;
    const preparationSamples = samples.filter((sample) => sample.phase === 'recoveryPrepare');
    measurement.allTrialsProbes = summarizeAll(samples);
    measurement.allTrialsProbesByPhase = Object.fromEntries(
      phases.map((phase) => [
        phase,
        summarizeAll(samples.filter((sample) => sample.phase === phase)),
      ])
    );
    measurement.probes ??= {};
    measurement.probes.recoveryPrepare = summarizeAll(preparationSamples);
    measurement.probeCoverage = {
      scope,
      probeFilesRead: names.length,
      uniqueSamples: samples.length,
      duplicateSamplesRemoved: records.length - samples.length,
      observedWindow: bounds(samples),
      samplesWithoutRecordedPhase: samples.filter((sample) => sample.phase === undefined).length,
      backupPrepare: { inferred: false, available: hasSeries(measurement.probes?.backupPrepare) },
      recoveryPrepare: {
        scope: preparationScope,
        inferred: false,
        available: preparationSamples.length > 0,
        uniqueSamples: preparationSamples.length,
        observedWindow: bounds(preparationSamples),
        missingControlSeries: missingControls(measurement.probes.recoveryPrepare),
      },
      recovery: recoveryCoverage(measurement),
    };
    if (inferBackupPrepare) {
      const end = measurement.backupFinishedAtMs ?? recorded?.backupFinishedAtMs;
      const duration = measurement.restorePreparationMs ?? recorded?.restorePreparationMs;
      if (finite(end) && finite(duration) && duration >= 0 && end >= duration) {
        const start = end - duration;
        measurement.probes ??= {};
        measurement.probes.backupPrepare = summarizeProbes(samples, start, end);
        measurement.probeCoverage.backupPrepare = {
          inferred: true,
          available: hasSeries(measurement.probes.backupPrepare),
          startedAtMs: start,
          finishedAtMs: end,
          method:
            'backupFinishedAtMs minus restorePreparationMs; final successful preparation only.',
          selection:
            'Recorded request interval overlaps the inferred window; this is an estimated wall-clock boundary.',
        };
      } else {
        measurement.probeCoverage.backupPrepare.reason =
          'Preparation timing is unavailable; no statistics were invented.';
      }
    }
  }
  const samples = [...overall.values()];
  const summary = summarizeAll(samples);
  const preparationSamples = samples.filter((sample) => sample.phase === 'recoveryPrepare');
  const preparation = summarizeAll(preparationSamples);
  output.probeAudit = {
    scope,
    probeFilesRead: files.size,
    uniqueSamples: samples.length,
    observedWindow: bounds(samples),
    controlRead: summary['control/read'] ?? emptySeries(),
    controlWrite: summary['control/write'] ?? emptySeries(),
    missingControlSeries: missingControls(summary),
    recoveryPrepare: {
      scope: preparationScope,
      uniqueSamples: preparationSamples.length,
      observedWindow: bounds(preparationSamples),
      controlRead: preparation['control/read'] ?? emptySeries(),
      controlWrite: preparation['control/write'] ?? emptySeries(),
      missingControlSeries: missingControls(preparation),
    },
    workerColos: locations(samples.map((sample) => sample.colo)),
    d1Colos: locations(samples.map((sample) => sample.meta?.served_by_colo)),
    d1Regions: locations(samples.map((sample) => sample.meta?.served_by_region)),
  };
  const databases = new Map(
    journal.databases.map((db, index) => [db.uuid ?? db.name ?? index, db])
  );
  output.cleanupSummary = {
    dbsCreated: databases.size,
    dbsDeleted: [...databases.values()].filter((db) => db.deleted === true).length,
    bucketDeleted: journal.bucket?.deleted === true,
    workerDeleted: journal.workerDeleted === true,
    objectKeysDeleted: new Set(
      (journal.objects ?? []).filter((entry) => entry.deleted === true).map((entry) => entry.key)
    ).size,
    objectKeysDeletedScope: cleanupKeyScope,
    completedAt: validDate(journal.cleanedUpAt) ? journal.cleanedUpAt : null,
  };
  return publicOnly(output, privateValues(journal));
}

function measurementKey(measurement) {
  assert.ok(finite(measurement.targetMiB) && measurement.targetMiB > 0, 'Invalid targetMiB.');
  assert.ok(Number.isSafeInteger(measurement.repeat) && measurement.repeat >= 1, 'Invalid repeat.');
  return `${measurement.targetMiB}/${measurement.repeat}`;
}

function validateProbeName(name, measurement) {
  assert.equal(typeof name, 'string', 'Invalid probe filename.');
  assert.match(
    name,
    /^r2-probes-[0-9]+(?:\.[0-9]+)?-[0-9]+-[0-9]+\.ndjson$/,
    'Unsafe probe filename.'
  );
  assert.ok(
    name.startsWith(`r2-probes-${measurement.targetMiB}-${measurement.repeat}-`),
    'Probe filename belongs to a different measurement.'
  );
}

function parseProbes(contents, name) {
  assert.ok(
    typeof contents === 'string' || contents instanceof Uint8Array,
    'Probe reader must return text or UTF-8 bytes.'
  );
  const text =
    typeof contents === 'string'
      ? contents
      : new TextDecoder('utf-8', { fatal: true }).decode(contents);
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Invalid probe JSON: ${name}, line ${index + 1}`);
      }
      assert.ok(['source', 'control', 'restore'].includes(value.target), 'Invalid probe target.');
      assert.ok(['read', 'write'].includes(value.operation), 'Invalid probe operation.');
      assert.equal(typeof value.ok, 'boolean', 'Probe success state is missing.');
      assert.ok(
        finite(value.startedMs) && finite(value.finishedMs) && value.finishedMs >= value.startedMs,
        'Invalid probe request timestamps.'
      );
      assert.ok(finite(value.elapsedMs) && value.elapsedMs >= 0, 'Probe elapsed time is missing.');
      return {
        target: value.target,
        operation: value.operation,
        ...(phases.includes(value.phase) ? { phase: value.phase } : {}),
        startedMs: value.startedMs,
        finishedMs: value.finishedMs,
        elapsedMs: value.elapsedMs,
        ok: value.ok,
        timeout: value.timeout === true,
        ...(finite(value.sqlWallMs) && value.sqlWallMs >= 0 ? { sqlWallMs: value.sqlWallMs } : {}),
        ...(location(value.colo) ? { colo: value.colo } : {}),
        meta: {
          ...(location(value.meta?.served_by_colo)
            ? { served_by_colo: value.meta.served_by_colo }
            : {}),
          ...(location(value.meta?.served_by_region)
            ? { served_by_region: value.meta.served_by_region }
            : {}),
        },
      };
    });
}

function sampleIdentity(sample) {
  return JSON.stringify([
    sample.target,
    sample.operation,
    sample.startedMs,
    sample.finishedMs,
    sample.elapsedMs,
    sample.ok,
    sample.timeout,
  ]);
}
function bounds(samples) {
  if (!samples.length) return { startedAtMs: null, finishedAtMs: null };
  return samples.reduce(
    (window, sample) => ({
      startedAtMs: Math.min(window.startedAtMs, sample.startedMs),
      finishedAtMs: Math.max(window.finishedAtMs, sample.finishedMs),
    }),
    { startedAtMs: Infinity, finishedAtMs: -Infinity }
  );
}
function summarizeAll(samples) {
  if (!samples.length) return {};
  const window = bounds(samples);
  return summarizeProbes(samples, window.startedAtMs, window.finishedAtMs);
}
function hasSeries(value) {
  return value && Object.keys(value).length > 0;
}
function missingControls(summary) {
  return ['control/read', 'control/write'].filter((name) => !summary[name]);
}
function recoveryCoverage(m) {
  const partialImport =
    m.importTimingMode === 'sum successful part stages after resume' ||
    Boolean(m.restoreTailPreparation);
  const resumed =
    partialImport ||
    m.recoveryTimingMode === 'sum completed provisioning/import/verification stages after resume' ||
    finite(m.resumeWorkerDeployMs);
  return {
    scope: partialImport
      ? 'Existing recovery probes cover remaining tail imports and verification in the final resumed recovery interval; earlier import attempts are included only in allTrialsProbes. Additional tail preparation is covered separately by recoveryPrepare.'
      : resumed
        ? 'Existing recovery probes cover final resumed verification only; earlier provisioning/import attempts are included only in allTrialsProbes.'
        : 'Existing recovery probes cover the final recovery interval; earlier failed attempts are included only in allTrialsProbes.',
    continuousEndToEndCoverage: !resumed,
    originalRecoveryProbesPreserved: true,
  };
}
function location(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9-]{1,15}$/.test(value);
}
function locations(values) {
  return [...new Set(values.filter(location))].sort();
}
function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function privateValues(journal) {
  const values = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (sensitiveKey.test(key) && typeof entry === 'string' && entry.length >= 8)
        values.add(entry);
      visit(entry);
    }
  };
  visit(journal);
  return [...values];
}
function publicOnly(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.replaceAll(secret, '[PRIVATE]');
    return value
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        '[RESOURCE_ID]'
      )
      .replace(/https?:\/\/\S+\?\S*(?:signature|token|X-Amz-|X-Goog-)\S*/gi, '[PRIVATE_URL]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [PRIVATE]');
  }
  if (Array.isArray(value)) return value.map((entry) => publicOnly(entry, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveKey.test(key))
        .map(([key, entry]) => [key, publicOnly(entry, secrets)])
    );
  return value;
}

async function regularFile(filename) {
  const info = await lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Expected a regular, non-symlink file.');
}

/** CLI writes only an explicitly named public JSON beside this script. */
async function cli(args) {
  const expected = ['--input-results', '--run-dir', '--output-results'];
  assert.equal(
    args.length,
    6,
    'Usage: r2-audit.mjs --input-results FILE --run-dir DIR --output-results FILE'
  );
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(
      expected.includes(args[index]) && !(args[index] in options),
      'Unknown or duplicate CLI option.'
    );
    options[args[index]] = args[index + 1];
  }
  assert.ok(expected.every((key) => typeof options[key] === 'string'));
  const directory = await realpath(path.dirname(fileURLToPath(import.meta.url)));
  const publicPath = async (value) => {
    const filename = path.resolve(value);
    assert.equal(
      await realpath(path.dirname(filename)),
      directory,
      'Public JSON must be directly in the benchmark directory.'
    );
    assert.match(path.basename(filename), /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/);
    assert.notEqual(
      path.basename(filename),
      'resources.json',
      'Refusing to overwrite a resource journal.'
    );
    return filename;
  };
  const input = await publicPath(options['--input-results']);
  const output = await publicPath(options['--output-results']);
  await regularFile(input);
  try {
    await regularFile(output);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const runDir = path.resolve(options['--run-dir']);
  const runInfo = await lstat(runDir);
  assert.ok(runInfo.isDirectory() && !runInfo.isSymbolicLink(), 'Expected a real run directory.');
  assert.equal(
    await realpath(path.dirname(runDir)),
    await realpath(path.join(directory, 'runs')),
    'Run directory must be directly under benchmark runs/.'
  );
  assert.match(path.basename(runDir), /^authrim-r2b-[a-z0-9-]+$/);
  const journalPath = path.join(runDir, 'resources.json');
  await regularFile(journalPath);
  const results = JSON.parse(await readFile(input, 'utf8'));
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(journal.runId, path.basename(runDir));
  assert.ok(
    validDate(results.completedAt) &&
      !results.partial &&
      results.measurements.every((m) => m.verified === true),
    'Audit CLI requires completed results.'
  );
  const audited = await auditResults(results, journal, async (name) => {
    const filename = path.join(runDir, name);
    await regularFile(filename);
    return readFile(filename);
  });
  const cleanup = audited.cleanupSummary;
  assert.ok(
    cleanup.completedAt &&
      cleanup.dbsCreated === cleanup.dbsDeleted &&
      cleanup.bucketDeleted &&
      cleanup.workerDeleted &&
      (journal.objects ?? []).every((entry) => entry.deleted === true),
    'Cleanup must finish before publishing the audit.'
  );
  const file = await open(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644
  );
  try {
    await file.writeFile(`${JSON.stringify(audited, null, 2)}\n`);
  } finally {
    await file.close();
  }
  process.stdout.write(`Audited results: ${path.basename(output)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Audit stopped: ${error.message}\n`);
    process.exitCode = 1;
  });
}
