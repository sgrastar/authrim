import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createCloudClient } from './cloud-client.mjs';
import { summarizeProbes } from './metrics.mjs';
import { pollD1Import } from './d1-import-poller.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const index = args.indexOf(`--${key}`);
  return index < 0 ? fallback : args[index + 1];
};
const accountId = option('account-id', process.env.CLOUDFLARE_ACCOUNT_ID);
assert.match(accountId ?? '', /^[a-f0-9]{32}$/, 'Pass --account-id');
const sizes = option('sizes', '100,1024,5120').split(',').map(Number);
const repetitions = option('repeats', '3,1,1').split(',').map(Number);
assert.ok(
  sizes.every((n, i) => Number.isFinite(n) && n > 0 && n <= 6000 && (!i || n >= sizes[i - 1]))
);
assert.ok(repetitions.every((n) => Number.isInteger(n) && n >= 1 && n <= 5));
const runId = option(
  'resume',
  `authrim-r2b-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()}-${randomBytes(2).toString('hex')}`
);
assert.match(runId, /^authrim-r2b-[a-z0-9-]+$/);
const runDir = path.join(directory, 'runs', runId);
await mkdir(runDir, { recursive: true, mode: 0o700 });
const journalPath = path.join(runDir, 'resources.json');
const state = option('resume')
  ? JSON.parse(await readFile(journalPath, 'utf8'))
  : {
      runId,
      accountId,
      createdAt: new Date().toISOString(),
      databases: [],
      measurements: [],
      objects: [],
    };
assert.equal(state.accountId, accountId);
for (const measurement of state.measurements) {
  if (measurement.beforeFingerprint && !measurement.fingerprintQueryStrategy)
    measurement.fingerprintQueryStrategy = 'legacy-v1';
}
let priorWorkerConfig;
try {
  priorWorkerConfig = JSON.parse(await readFile(path.join(runDir, 'r2-wrangler.jsonc'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const save = () => writeFile(journalPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
const clock = () => performance.now();
const safeError = (error) =>
  String(error?.message ?? error)
    .replace(/https?:\/\/\S+/g, '[URL]')
    .slice(0, 500);
const digest = (data) =>
  createHash('sha256')
    .update(typeof data === 'string' ? data : JSON.stringify(data))
    .digest('hex');
await save();
const { api, wrangler } = await createCloudClient({ accountId, runDir, log });

function endpoint(db) {
  assert.ok(db.name.startsWith(`${runId}-`));
  assert.ok(state.databases.some((entry) => entry.uuid === db.uuid && entry.name === db.name));
  return `d1/database/${db.uuid}`;
}
async function createDatabase(role) {
  log(`Creating dedicated ${role} D1`);
  const db = await api('d1/database', {
    method: 'POST',
    body: { name: `${runId}-${role}`, primary_location_hint: 'apac' },
  });
  const entry = { uuid: db.uuid, name: db.name, role, deleted: false };
  state.databases.push(entry);
  await save();
  return entry;
}
async function deleteDatabase(db) {
  if (db.deleted) return;
  db.deleteRequested = true;
  await save();
  try {
    const current = await api(endpoint(db));
    assert.equal(current.name, db.name);
    await api(endpoint(db), { method: 'DELETE' });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  db.deleted = true;
  await save();
  log(`Deleted dedicated ${db.role} D1`);
}
async function query(db, sql, retry = false) {
  assert.ok(!db.deleted, 'Refusing to query a deleted source');
  const result = await api(`${endpoint(db)}/query`, { method: 'POST', body: { sql }, retry });
  assert.ok(
    result.every((entry) => entry.success),
    'D1 SQL failed'
  );
  return result;
}
async function prepare() {
  const source =
    state.databases.find((entry) => entry.role === 'source') ?? (await createDatabase('source'));
  const control =
    state.databases.find((entry) => entry.role === 'control' && !entry.deleted) ??
    (await createDatabase('control'));
  if (source.deleteRequested && !source.deleted) {
    try {
      await api(endpoint(source));
    } catch (error) {
      if (error.status !== 404) throw error;
      source.deleted = true;
      await save();
    }
  }
  if (!state.bucket) {
    state.bucket = { name: `${runId}-backups`, deleted: false };
    await save();
    await api('r2/buckets', {
      method: 'POST',
      body: { name: state.bucket.name, locationHint: 'apac' },
    });
    state.bucket.created = true;
    await save();
    log('Created dedicated private R2 backup bucket');
  }
  return { source, control };
}
async function discoverSignedHosts(source) {
  await query(source, 'SELECT 1');
  let response;
  do {
    response = await api(`${endpoint(source)}/export`, {
      method: 'POST',
      body: { output_format: 'polling', current_bookmark: response?.at_bookmark },
      retry: true,
    });
    if (response.status === 'error') throw new Error('Empty export discovery failed');
  } while (response.status !== 'complete');
  const exportedHost = new URL(response.result.signed_url).hostname;
  const md5 = createHash('md5').update(`url-discovery-${runId}`).digest('hex');
  const initialized = await api(`${endpoint(source)}/import`, {
    method: 'POST',
    body: { action: 'init', etag: md5 },
  });
  state.discovery = {
    exportHostname: exportedHost,
    importHostname: new URL(initialized.upload_url).hostname,
  };
  await save();
  log(`Signed URL hostnames: ${JSON.stringify(state.discovery)}`);
}

let workerSecret;
async function deployWorker(source, control, restore) {
  const started = clock();
  const tokenPath = path.join(runDir, 'bench-token.secret');
  if (!workerSecret) {
    try {
      workerSecret = await readFile(tokenPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      workerSecret = randomBytes(32).toString('hex');
      await writeFile(tokenPath, workerSecret, { mode: 0o600 });
    }
  }
  const configPath = path.join(runDir, 'r2-wrangler.jsonc');
  const secretsPath = path.join(runDir, 'r2-secrets.json');
  const bindings = [
    ...(!source.deleted
      ? [{ binding: 'SOURCE', database_name: source.name, database_id: source.uuid }]
      : []),
    { binding: 'CONTROL', database_name: control.name, database_id: control.uuid },
    ...(restore
      ? [{ binding: 'RESTORE', database_name: restore.name, database_id: restore.uuid }]
      : []),
  ];
  await writeFile(
    configPath,
    JSON.stringify(
      {
        name: runId,
        account_id: accountId,
        main: path.join(directory, 'r2-worker.mjs'),
        compatibility_date: '2026-10-16',
        compatibility_flags: ['nodejs_compat'],
        workers_dev: true,
        preview_urls: false,
        limits: { cpu_ms: 300000 },
        observability: { enabled: true, head_sampling_rate: 0.01 },
        vars: { RUN_PREFIX: runId },
        d1_databases: bindings,
        r2_buckets: [{ binding: 'BACKUPS', bucket_name: state.bucket.name }],
      },
      null,
      2
    )
  );
  await writeFile(secretsPath, JSON.stringify({ BENCH_TOKEN: workerSecret }), { mode: 0o600 });
  if (!state.workerName) {
    await wrangler(
      ['types', '--config', configPath, path.join(runDir, 'r2-worker-configuration.d.ts')],
      'r2-types'
    );
    await wrangler(['deploy', '--config', configPath, '--dry-run'], 'r2-dry-run');
  }
  state.workerName = runId;
  await save();
  const output = await wrangler(
    ['deploy', '--config', configPath, '--secrets-file', secretsPath],
    `r2-deploy-${state.databases.length}`
  );
  await unlink(secretsPath);
  state.workerUrl = output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  assert.ok(state.workerUrl, 'Missing Worker URL');
  await save();
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${state.workerUrl}/read?target=control`, {
        headers: { Authorization: `Bearer ${workerSecret}` },
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) return clock() - started;
    } catch {
      /* Deployment propagation. */
    }
    await delay(1000);
  }
  throw new Error('R2 Worker is unavailable');
}
async function workerJson(route, method = 'GET', body) {
  const response = await fetch(`${state.workerUrl}${route}`, {
    method,
    headers: { Authorization: `Bearer ${workerSecret}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok)
    throw new Error(`Worker ${route.split('?')[0]} ${response.status}: ${result.error}`);
  return result;
}
async function transfer(route, body) {
  const response = await fetch(`${state.workerUrl}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${workerSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(7200000),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Cloud transfer rejected: ${error.error ?? response.status}`);
  }
  const decoder = new TextDecoder();
  let pending = '';
  let final;
  let lastProgress = 0;
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    assert.ok(pending.length < 65536, 'Unexpected oversized progress frame');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (
        ['/prepare-restore', '/prepare-tail'].includes(route) &&
        frame.type === 'progress' &&
        typeof frame.key === 'string'
      ) {
        assert.ok(frame.key.startsWith(`${body.preparedPrefix}/`));
        if (!state.objects.some((entry) => entry.key === frame.key)) {
          state.objects.push({ key: frame.key, deleted: false });
          await save();
        }
      }
      if (frame.type === 'error') throw new Error(`Cloud transfer ${route}: ${frame.error}`);
      if (frame.type === 'result') {
        assert.equal(frame.ok, true);
        final = frame;
      }
      if (frame.type === 'progress' && clock() - lastProgress > 20000) {
        log(`${route}: ${(frame.bytes / 1024 ** 2).toFixed(1)} MiB transferred within Cloudflare`);
        lastProgress = clock();
      }
    }
  }
  assert.ok(final?.ok, 'Cloud transfer ended without a final success frame');
  assert.equal(pending.trim(), '');
  return final;
}
function monitor(name) {
  const samples = [];
  const file = createWriteStream(path.join(runDir, `${name}.ndjson`), { mode: 0o600 });
  const pending = new Set();
  const active = new Map();
  let sourceEnabled = true;
  let skips = 0;
  let phase = 'baseline';
  async function one(target, operation, samplePhase) {
    const startedMs = Date.now();
    const start = clock();
    let sample;
    try {
      const response = await fetch(`${state.workerUrl}/${operation}?target=${target}`, {
        method: operation === 'write' ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${workerSecret}` },
        signal: AbortSignal.timeout(90000),
      });
      const result = await response.json();
      sample = {
        ok: response.ok && result.ok,
        status: response.status,
        error: result.error,
        sqlWallMs: result.sqlWallMs,
        meta: result.meta,
        colo: result.colo,
      };
    } catch (error) {
      sample = { ok: false, error: error.name, timeout: error.name === 'TimeoutError' };
    }
    sample = {
      target,
      operation,
      phase: samplePhase,
      startedMs,
      finishedMs: Date.now(),
      elapsedMs: clock() - start,
      ...sample,
    };
    samples.push(sample);
    file.write(`${JSON.stringify(sample)}\n`);
  }
  function tick() {
    for (const [target, operation] of [
      ...(sourceEnabled ? [['source', 'read']] : []),
      ['control', 'read'],
      ['control', 'write'],
    ]) {
      const key = `${target}/${operation}`;
      if ((active.get(key) ?? 0) >= 8) {
        skips++;
        continue;
      }
      active.set(key, (active.get(key) ?? 0) + 1);
      const task = one(target, operation, phase);
      pending.add(task);
      task.finally(() => {
        pending.delete(task);
        active.set(key, active.get(key) - 1);
      });
    }
  }
  const timer = setInterval(tick, 1000);
  tick();
  return {
    samples,
    phase(value) {
      phase = value;
      if (value === 'recovery') sourceEnabled = false;
    },
    async stop() {
      clearInterval(timer);
      await Promise.allSettled([...pending]);
      await new Promise((resolve) => file.end(resolve));
      return skips;
    },
  };
}
async function pollImport(db, initial, measurement) {
  let lastLog = clock();
  let lastSave = clock();
  const { response } = await pollD1Import({
    initial,
    poll: ({ currentBookmark, signal, timeoutMs }) =>
      api(`${endpoint(db)}/import`, {
        method: 'POST',
        body: { action: 'poll', current_bookmark: currentBookmark },
        timeoutMs,
        signal,
        retry: false,
      }),
    onCheckpoint: async ({ response: current, currentBookmark, stats, terminal }) => {
      if (measurement) {
        measurement.importPolls = stats.polls;
        measurement.importPolling = stats;
        if (current.status === 'complete') {
          measurement.importMeta = current.result?.meta;
          measurement.importNumQueries = current.result?.num_queries;
        }
      }
      if (terminal || clock() - lastSave > 10000) {
        await writeFile(
          path.join(runDir, 'import-poll-current.json'),
          JSON.stringify({
            restoreRole: db.role,
            currentBookmark,
            status: current.status,
            stats,
            observedAt: new Date().toISOString(),
          }),
          { mode: 0o600 }
        );
        await save();
        lastSave = clock();
      }
      if (clock() - lastLog > 30000) {
        log(`D1 ingest continues (${stats.polls} status polls)`);
        lastLog = clock();
      }
    },
    onEvent: async ({ currentBookmark: _bookmark, ...event }) => {
      if (measurement) (measurement.importPollingEvents ??= []).push(event);
      log(`Retrying bounded D1 import poll: ${event.errorName}`);
      await save();
    },
  });
  return response;
}
async function applySchema(source, batches) {
  for (let index = state.schemaBatchIndex ?? 0; index < batches.length; index++) {
    const result = await api(`${endpoint(source)}/query`, {
      method: 'POST',
      body: { batch: batches[index].map((sql) => ({ sql })) },
    });
    assert.ok(
      result.every((entry) => entry.success),
      'Schema batch failed'
    );
    state.schemaBatchIndex = index + 1;
    await save();
    log(`Authrim schema batch ${index + 1}/${batches.length} applied`);
  }
}
async function growSource(source, targetMiB, fixture) {
  let result = (await query(source, 'SELECT COUNT(*) AS n FROM users_core'))[0];
  let accountCount = result.results[0].n;
  let sizeBytes = result.meta.size_after;
  let lastLog = 0;
  while (sizeBytes < targetMiB * 1024 ** 2) {
    const sql = fixture.seedSql(accountCount + 1, fixture.MAX_SEED_ACCOUNTS);
    const results = await query(source, sql, true);
    accountCount += fixture.MAX_SEED_ACCOUNTS;
    sizeBytes = results.at(-1).meta.size_after;
    if (clock() - lastLog > 15000 || sizeBytes >= targetMiB * 1024 ** 2) {
      log(
        `Authrim fixture ${targetMiB} MiB: ${(sizeBytes / 1024 ** 2).toFixed(1)} MiB; ${accountCount} accounts`
      );
      lastLog = clock();
    }
  }
  state.sourceDataset = { sizeBytes, accountCount, targetMiB };
  await save();
  return state.sourceDataset;
}
async function exportAndStore(source, measurement, observer) {
  const started = clock();
  measurement.exportStartedAtMs = Date.now();
  observer.phase('export');
  let response;
  let polls = 0;
  do {
    response = await api(`${endpoint(source)}/export`, {
      method: 'POST',
      body: { output_format: 'polling', current_bookmark: response?.at_bookmark },
      retry: true,
    });
    polls++;
    if (response.status === 'error' || response.success === false)
      throw new Error('D1 export failed');
  } while (response.status !== 'complete');
  measurement.exportReadyAtMs = Date.now();
  measurement.exportApiMs = clock() - started;
  measurement.exportPolls = polls;
  await save();
  log(`D1 SQL export ready in ${(measurement.exportApiMs / 1000).toFixed(2)}s`);
  observer.phase('backupCopy');
  const key = `${runId}/${measurement.targetMiB}-${measurement.repeat}-${state.measurements.length}.sql`;
  if (!state.objects.some((entry) => entry.key === key))
    state.objects.push({ key, deleted: false });
  measurement.objectKey = key;
  await save();
  measurement.backup = await transfer('/backup', {
    key,
    signedUrl: response.result.signed_url,
    context: {
      profile: state.profile.name,
      schemaSha256: measurement.beforeFingerprint.schemaSha256,
      fingerprintDigest: digest(measurement.beforeFingerprint),
    },
  });
  await confirmBackup(measurement);
  measurement.backupTotalMs = clock() - started;
  measurement.backupFinishedAtMs = Date.now();
  measurement.rawBackupTotalMs = measurement.backupTotalMs;
  measurement.rawBackupFinishedAtMs = measurement.backupFinishedAtMs;
  await save();
  log(
    `Own R2 backup committed ${(measurement.backup.sizeBytes / 1024 ** 2).toFixed(2)} MiB; copy ${(measurement.backup.totalMs / 1000).toFixed(2)}s; backup total ${(measurement.backupTotalMs / 1000).toFixed(2)}s`
  );
}
async function confirmBackup(measurement) {
  const object = await workerJson(`/object?key=${encodeURIComponent(measurement.objectKey)}`);
  assert.equal(object.head.size, measurement.backup.sizeBytes);
  assert.equal(object.head.etag, object.manifest.objectEtag);
  assert.equal(object.manifest.md5, measurement.backup.md5);
  assert.equal(object.manifest.sha256, measurement.backup.sha256);
  assert.equal(object.manifest.context.fingerprintDigest, digest(measurement.beforeFingerprint));
  measurement.backupConfirmed = true;
  await save();
}
async function prepareRestoreFiles(measurement, observer) {
  if (
    !measurement.restorePreparation?.parts.some((part) => part.kind === 'foreign-key-finalizer')
  ) {
    observer.phase('backupPrepare');
    const started = clock();
    const targetChunkBytes = 1024 ** 3;
    const preparedPrefix = `${measurement.objectKey}.restore`;
    if (!state.objects.some((entry) => entry.key === `${preparedPrefix}/index.manifest.json`))
      state.objects.push({ key: `${preparedPrefix}/index.manifest.json`, deleted: false });
    const maximumParts = Math.ceil(measurement.backup.sizeBytes / targetChunkBytes) + 2;
    for (let index = 1; index <= maximumParts; index++) {
      const key = `${preparedPrefix}/${String(index).padStart(4, '0')}.sql`;
      if (!state.objects.some((entry) => entry.key === key))
        state.objects.push({ key, deleted: false });
    }
    await save();
    measurement.restorePreparation = await transfer('/prepare-restore', {
      key: measurement.objectKey,
      expectedMd5: measurement.backup.md5,
      expectedSha256: measurement.backup.sha256,
      expectedBytes: measurement.backup.sizeBytes,
      preparedPrefix,
      targetChunkBytes,
    });
    assert.equal(measurement.restorePreparation.rawMd5, measurement.backup.md5);
    assert.equal(measurement.restorePreparation.rawSha256, measurement.backup.sha256);
    assert.equal(measurement.restorePreparation.rawBytes, measurement.backup.sizeBytes);
    assert.ok(measurement.restorePreparation.parts.length >= 1);
    measurement.rawBackupTotalMs ??= measurement.backupTotalMs;
    measurement.rawBackupFinishedAtMs ??= measurement.backupFinishedAtMs;
    measurement.restorePreparationMs = clock() - started;
    measurement.backupTotalMs = measurement.rawBackupTotalMs + measurement.restorePreparationMs;
    measurement.backupFinishedAtMs = Date.now();
    await save();
    log(
      `Prepared ${measurement.restorePreparation.parts.length} restoration SQL file(s) in ${(measurement.restorePreparationMs / 1000).toFixed(2)}s`
    );
  }
  const committed = await workerJson(
    `/prepared?prefix=${encodeURIComponent(`${measurement.objectKey}.restore`)}`
  );
  assert.equal(committed.index.rawMd5, measurement.backup.md5);
  assert.equal(committed.index.rawSha256, measurement.backup.sha256);
  assert.equal(committed.index.context.fingerprintDigest, digest(measurement.beforeFingerprint));
  const partIdentity = (part) => ({
    key: part.key,
    sizeBytes: part.sizeBytes,
    md5: part.md5,
    sha256: part.sha256,
  });
  assert.deepEqual(
    committed.index.parts.map(partIdentity),
    measurement.restorePreparation.parts.map(partIdentity)
  );
  for (const part of measurement.restorePreparation.parts) {
    assert.ok(part.key.startsWith(`${measurement.objectKey}.restore/`));
    const object = await workerJson(`/object?key=${encodeURIComponent(part.key)}`);
    assert.equal(object.head.size, part.sizeBytes);
    assert.equal(object.head.etag, object.manifest.objectEtag);
    assert.equal(object.manifest.md5, part.md5);
    assert.equal(object.manifest.sha256, part.sha256);
    assert.equal(object.manifest.context.fingerprintDigest, digest(measurement.beforeFingerprint));
    if (!state.objects.some((entry) => entry.key === part.key))
      state.objects.push({ key: part.key, deleted: false });
  }
  measurement.preparedBackupConfirmed = true;
  await save();
}
const activeRestoreParts = (measurement) =>
  measurement.restoreTailPreparation
    ? [
        ...measurement.restorePreparation.parts.slice(0, measurement.restoreTailBasePartCount),
        ...measurement.restoreTailPreparation.parts,
      ]
    : measurement.restorePreparation.parts;

async function prepareRestoreTail(measurement, observer) {
  const checkpoint = measurement.importResumeCheckpoint;
  assert.equal(checkpoint?.validated, true);
  measurement.restoreTailBasePartCount ??= checkpoint.completedPartCount;
  const original = measurement.restorePreparation.parts[measurement.restoreTailBasePartCount];
  measurement.restoreTailOriginalPartKey ??= checkpoint.failedPartKey;
  assert.equal(original.key, measurement.restoreTailOriginalPartKey);
  const preparedPrefix = `${original.key}.schema-split`;
  if (!measurement.restoreTailPreparation) {
    observer.phase('recoveryPrepare');
    const indexKey = `${preparedPrefix}/index.manifest.json`;
    const keys = [
      indexKey,
      ...Array.from(
        { length: 256 },
        (_, i) => `${preparedPrefix}/${String(i + 1).padStart(4, '0')}.sql`
      ),
    ];
    for (const key of keys)
      if (!state.objects.some((entry) => entry.key === key))
        state.objects.push({ key, deleted: false });
    await save();
    const started = clock();
    measurement.restoreTailPreparation = await transfer('/prepare-tail', {
      key: original.key,
      expectedMd5: original.md5,
      expectedSha256: original.sha256,
      expectedBytes: original.sizeBytes,
      preparedPrefix,
      targetChunkBytes: 1024 ** 3,
      populatedTables: [
        'users_core',
        'identity_subjects',
        'identity_accounts',
        'subject_account_links',
        'passkeys',
        'role_assignments',
        'oauth_client_consents',
        'sessions',
        'user_token_families',
        'account_webhook_outbox',
        'service_group_inputs',
        'account_legal_hold_states',
      ],
      emptyIndexGroupSize: 16,
      triggerGroupSize: 16,
    });
    measurement.restoreTailPreparationMs = clock() - started;
    await save();
    log(`Prepared ${measurement.restoreTailPreparation.parts.length} data/schema tail files`);
  }
  const committed = await workerJson(`/prepared?prefix=${encodeURIComponent(preparedPrefix)}`);
  assert.equal(committed.index.rawMd5, original.md5);
  assert.equal(committed.index.rawSha256, original.sha256);
  assert.equal(committed.index.rawBytes, original.sizeBytes);
  assert.equal(committed.index.context.fingerprintDigest, digest(measurement.beforeFingerprint));
  const identity = ({ key, sizeBytes, md5, sha256 }) => ({ key, sizeBytes, md5, sha256 });
  assert.deepEqual(
    committed.index.parts.map(identity),
    measurement.restoreTailPreparation.parts.map(identity)
  );
  for (const part of measurement.restoreTailPreparation.parts) {
    if (!state.objects.some((entry) => entry.key === part.key))
      state.objects.push({ key: part.key, deleted: false });
    const object = await workerJson(`/object?key=${encodeURIComponent(part.key)}`);
    assert.equal(object.head.size, part.sizeBytes);
    assert.equal(object.head.etag, object.manifest.objectEtag);
    assert.equal(object.manifest.md5, part.md5);
    assert.equal(object.manifest.sha256, part.sha256);
  }
  measurement.restoreTailPreparationConfirmed = true;
  checkpoint.resumePartKey ??= measurement.restoreTailPreparation.parts[0].key;
  await save();
}

async function restoreFromR2(restore, measurement, { resumeFromPart = 0 } = {}) {
  const started = clock();
  if (resumeFromPart) {
    const checkpoint = measurement.importResumeCheckpoint;
    assert.equal(checkpoint?.validated, true, 'A verified rollback checkpoint is required');
    assert.equal(checkpoint.restoreRole, restore.role);
    assert.equal(checkpoint.completedPartCount, resumeFromPart);
    assert.ok(
      measurement.importParts.slice(resumeFromPart).every((part) => !part.importTotalMs),
      'Stale rollback checkpoint: completed tail files require renewed validation before resume'
    );
    assert.equal(
      checkpoint.resumePartKey ?? checkpoint.failedPartKey,
      activeRestoreParts(measurement)[resumeFromPart].key
    );
    for (let i = 0; i < resumeFromPart; i++) {
      const imported = measurement.importParts[i];
      assert.equal(imported?.key, activeRestoreParts(measurement)[i].key);
      assert.ok(Number.isFinite(imported.importTotalMs) && imported.importTotalMs > 0);
    }
    measurement.importParts = measurement.importParts.slice(0, resumeFromPart);
    measurement.importTimingMode = 'sum successful part stages after resume';
    log(`Resuming dedicated restore after ${resumeFromPart} completed SQL files`);
  } else {
    measurement.importParts = [];
  }
  delete measurement.restoreUpload;
  delete measurement.uploadReused;
  delete measurement.foreignKeyReadiness;
  delete measurement.foreignKeyEnableMs;
  for (const part of activeRestoreParts(measurement).slice(resumeFromPart)) {
    const imported = { key: part.key, kind: part.kind ?? 'data' };
    measurement.importParts.push(imported);
    await importPart(restore, part, imported);
    await save();
  }
  const sum = (field) =>
    measurement.importParts.reduce((total, part) => total + (part[field] ?? 0), 0);
  measurement.importInitMs = sum('importInitMs');
  measurement.ingestObservedMs = sum('ingestObservedMs');
  measurement.restoreUpload = {
    totalMs: measurement.importParts.reduce(
      (total, part) => total + (part.restoreUpload?.totalMs ?? 0),
      0
    ),
    sizeBytes: measurement.importParts.reduce(
      (total, part) => total + (part.restoreUpload?.sizeBytes ?? 0),
      0
    ),
  };
  measurement.uploadReused = measurement.importParts.some((part) => part.uploadReused);
  measurement.foreignKeyEnableMs = measurement.importParts.find(
    (part) => part.kind === 'foreign-key-finalizer'
  )?.importTotalMs;
  measurement.importTotalMs = resumeFromPart ? sum('importTotalMs') : clock() - started;
  await save();
  log(
    `R2->D1 ${measurement.importParts.length} file(s) import ${(measurement.importTotalMs / 1000).toFixed(2)}s; ingest ${(measurement.ingestObservedMs / 1000).toFixed(2)}s`
  );
}
async function importPart(restore, part, measurement) {
  const started = clock();
  const initStarted = clock();
  const init = await api(`${endpoint(restore)}/import`, {
    method: 'POST',
    body: { action: 'init', etag: part.md5 },
  });
  measurement.importInitMs = clock() - initStarted;
  let response = init;
  if (init.upload_url) {
    measurement.restoreUpload = await transfer('/restore-upload', {
      key: part.key,
      uploadUrl: init.upload_url,
      expectedMd5: part.md5,
      expectedBytes: part.sizeBytes,
    });
    assert.equal(measurement.restoreUpload.integrityVerified, true);
    await save();
    const ingestStart = clock();
    measurement.ingestStartedAtMs = Date.now();
    response = await api(`${endpoint(restore)}/import`, {
      method: 'POST',
      body: { action: 'ingest', filename: init.filename, etag: part.md5 },
    });
    await pollImport(restore, response, measurement);
    measurement.ingestObservedMs = clock() - ingestStart;
  } else {
    measurement.uploadReused = true;
    const ingestStart = clock();
    await pollImport(restore, response, measurement);
    measurement.ingestObservedMs = clock() - ingestStart;
  }
  measurement.importTotalMs = clock() - started;
  await save();
  log(
    `R2->D1 part import ${(measurement.importTotalMs / 1000).toFixed(2)}s; ingest ${(measurement.ingestObservedMs / 1000).toFixed(2)}s`
  );
}
async function checkForeignKeys(db) {
  const mode = (await query(db, 'PRAGMA foreign_keys'))[0].results;
  assert.equal(
    mode[0]?.foreign_keys,
    1,
    'Foreign-key enforcement is not enabled after restoration'
  );
  const tables = (
    await query(
      db,
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    )
  )[0].results;
  for (let index = 0; index < tables.length; index += 12) {
    const statements = tables
      .slice(index, index + 12)
      .map(({ name }) => `PRAGMA foreign_key_check('${name.replaceAll("'", "''")}')`);
    const result = await query(db, statements.join(';'), true);
    assert.equal(result.length, statements.length);
    assert.ok(
      result.every((entry) => entry.results.length === 0),
      'Foreign-key integrity check failed'
    );
  }
  return tables.length;
}
async function checkTables(db) {
  const tables = (
    await query(
      db,
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    )
  )[0].results.map((row) => row.name);
  tables.push('sqlite_schema');
  for (let index = 0; index < tables.length; index += 12) {
    const sql = tables
      .slice(index, index + 12)
      .map((name) => `PRAGMA quick_check('${name.replaceAll("'", "''")}')`)
      .join(';');
    const checks = await query(db, sql, true);
    assert.ok(
      checks.every(
        (entry) =>
          entry.results.length === 1 &&
          entry.results.every((row) => Object.values(row).every((value) => value === 'ok'))
      ),
      'Per-table integrity check failed'
    );
  }
  return tables.length;
}
async function waitForeignKeyReadiness(db, measurement) {
  const started = clock();
  const samples = [];
  let consecutive = 0;
  while (clock() - started < 60000) {
    let apiMode;
    let bindingMode;
    try {
      apiMode = (await query(db, 'PRAGMA foreign_keys'))[0].results[0]?.foreign_keys;
      bindingMode = (await workerJson('/foreign-key-mode?target=restore')).foreignKeys;
      samples.push({ elapsedMs: clock() - started, apiMode, bindingMode });
    } catch (error) {
      samples.push({ elapsedMs: clock() - started, apiMode, bindingMode, error: safeError(error) });
      if (!safeError(error).includes('D1_UNAVAILABLE')) throw error;
      consecutive = 0;
      await delay(1000);
      continue;
    }
    consecutive = apiMode === 1 && bindingMode === 1 ? consecutive + 1 : 0;
    if (consecutive >= 3) {
      measurement.foreignKeyReadiness = { durationMs: clock() - started, samples };
      await save();
      return;
    }
    await delay(1000);
  }
  measurement.foreignKeyReadiness = { durationMs: clock() - started, samples };
  await save();
  throw new Error('Foreign-key enforcement did not become ready within 60 seconds');
}
async function cleanup() {
  if (state.workerName && !state.workerDeleted) {
    if (!workerSecret)
      workerSecret = await readFile(path.join(runDir, 'bench-token.secret'), 'utf8');
    for (const entry of state.objects.filter((entry) => !entry.deleted)) {
      await workerJson(`/object?key=${encodeURIComponent(entry.key)}`, 'DELETE');
      entry.deleted = true;
      await save();
    }
  }
  if (state.bucket?.created && !state.bucket.deleted) {
    assert.equal(state.bucket.name, `${runId}-backups`);
    await api(`r2/buckets/${state.bucket.name}`, { method: 'DELETE' });
    state.bucket.deleted = true;
    await save();
  }
  if (state.workerName && !state.workerDeleted) {
    assert.equal(state.workerName, runId);
    try {
      await api(`workers/scripts/${runId}`, { method: 'DELETE' });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    state.workerDeleted = true;
    await save();
  }
  for (const db of state.databases) await deleteDatabase(db);
  state.cleanedUpAt = new Date().toISOString();
  await save();
  log('Dedicated D1s, R2 objects/manifests/bucket and Worker removed');
}

async function main() {
  if (args.includes('--cleanup')) {
    assert.ok(option('resume'), '--cleanup requires --resume');
    await cleanup();
    return;
  }
  const { source, control } = await prepare();
  if (args.includes('--prepare-only')) {
    await discoverSignedHosts(source);
    log(`Prepared ${runId}`);
    return;
  }
  const fixture = await import('./authrim-fixture.mjs');
  const { fingerprint } = await import('./authrim-fingerprint.mjs');
  if (!state.schemaReady) {
    const schemaPath = path.join(runDir, 'schema-plan.json');
    let plan;
    try {
      plan = JSON.parse(await readFile(schemaPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const compiled = await fixture.compileSchema();
      plan = { profile: compiled.profile, batches: fixture.schemaProvisioningBatches(compiled) };
      await writeFile(schemaPath, JSON.stringify(plan), { mode: 0o600 });
    }
    state.profile = plan.profile;
    await save();
    log(
      `Applying canonical Authrim core schema: ${plan.profile.tableCount} tables, ${plan.profile.indexCount} indexes, ${plan.profile.triggerCount} triggers`
    );
    await applySchema(source, plan.batches);
    await query(
      control,
      'CREATE TABLE IF NOT EXISTS bench_probe(id INTEGER PRIMARY KEY,writes INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO bench_probe VALUES(1,0);',
      true
    );
    state.schemaReady = true;
    await save();
  }
  await deployWorker(source, control);
  for (let index = 0; index < sizes.length; index++) {
    const targetMiB = sizes[index];
    const repeats = repetitions[index] ?? repetitions.at(-1);
    if (
      Array.from({ length: repeats }, (_, i) => i + 1).every((repeat) =>
        state.measurements.some(
          (m) => m.targetMiB === targetMiB && m.repeat === repeat && m.verified
        )
      )
    )
      continue;
    const dataset = source.deleted
      ? state.sourceDataset
      : await growSource(source, targetMiB, fixture);
    assert.equal(dataset.targetMiB, targetMiB);
    for (let repeat = 1; repeat <= repeats; repeat++) {
      if (
        state.measurements.some(
          (m) => m.targetMiB === targetMiB && m.repeat === repeat && m.verified
        )
      )
        continue;
      let measurement = state.measurements.find(
        (m) => m.targetMiB === targetMiB && m.repeat === repeat && !m.verified
      );
      if (!measurement) {
        measurement = { ...dataset, repeat, measuredAt: new Date().toISOString() };
        state.measurements.push(measurement);
      }
      measurement.sourceDeletedForRecovery ??= false;
      const resumePartialImport = Boolean(
        args.includes('--resume-import') &&
        !measurement.importCompleted &&
        measurement.importResumeCheckpoint?.validated
      );
      if (resumePartialImport) {
        assert.ok(option('resume'), '--resume-import requires --resume');
        assert.match(
          measurement.error ?? '',
          /Cancelled due to no poll\(\) received in 15000ms|polling exhausted consecutive request retries/,
          'Only a verified cancelled import can resume from its saved file checkpoint'
        );
      }
      if (measurement.error) {
        if (measurement.foreignKeyCheck === 'ok' && measurement.error.includes('SQLITE_NOMEM'))
          measurement.fullQuickCheckError ??= measurement.error;
        if (
          !measurement.restoreRole &&
          measurement.foreignKeyCheck === 'ok' &&
          measurement.importParts?.length === measurement.restorePreparation?.parts.length &&
          measurement.importParts.every((part) => part.importTotalMs)
        ) {
          const priorConfig = priorWorkerConfig;
          assert.equal(priorConfig.name, runId);
          const binding = priorConfig.d1_databases.find((entry) => entry.binding === 'RESTORE');
          const prior = state.databases.find(
            (entry) =>
              entry.uuid === binding?.database_id &&
              !entry.deleted &&
              entry.role.startsWith(`restore-${targetMiB}-${repeat}-`)
          );
          assert.ok(prior, 'Cannot reconcile a completed import with its dedicated restore D1');
          measurement.restoreRole = prior.role;
          measurement.importCompleted = true;
        }
        if (measurement.importTotalMs && !measurement.resumeWorkerDeployMs) {
          (measurement.previousRecoveryAttempts ??= []).push({
            error: measurement.error,
            importTotalMs: measurement.importTotalMs,
            importParts: measurement.importParts,
            foreignKeyReadiness: measurement.error.startsWith(
              'Foreign-key enforcement did not become ready'
            )
              ? measurement.foreignKeyReadiness
              : undefined,
          });
        } else if (measurement.resumeWorkerDeployMs && measurement.importCompleted) {
          (measurement.previousVerificationErrors ??= []).push(measurement.error);
        }
        if (
          measurement.backup &&
          !measurement.restorePreparation &&
          !measurement.rawImportFailure &&
          measurement.error.startsWith('D1 import error:')
        ) {
          measurement.rawImportFailure = {
            error: measurement.error,
            restoreUpload: measurement.restoreUpload,
            importInitMs: measurement.importInitMs,
            ingestStartedAtMs: measurement.ingestStartedAtMs,
            recoveryStartedAtMs: measurement.recoveryStartedAtMs,
          };
        }
        (measurement.previousErrors ??= []).push(measurement.error);
        delete measurement.error;
      }
      await save();
      if (!measurement.beforeFingerprint) {
        try {
          assert.ok(!source.deleted);
          measurement.fingerprintQueryStrategy = 'pk-range-v2-outbox-global';
          measurement.beforeFingerprint = await fingerprint(query, source, {
            accountCount: measurement.accountCount,
          });
          await save();
        } catch (error) {
          measurement.error = safeError(error);
          await save();
          throw error;
        }
      }
      const probePrefix = `r2-probes-${targetMiB}-${repeat}-`;
      measurement.probeFiles ??= (await readdir(runDir)).filter(
        (name) => name.startsWith(probePrefix) && name.endsWith('.ndjson')
      );
      const probeName = `${probePrefix}${Date.now()}`;
      measurement.probeFiles.push(`${probeName}.ndjson`);
      await save();
      const observer = monitor(probeName);
      const baselineStart = Date.now();
      await delay(10000);
      const baselineEnd = Date.now();
      try {
        if (!measurement.backup) {
          // Give every repetition a distinct SQL hash, avoiding the import upload cache.
          // bench_probe is excluded from the account/schema fingerprint.
          await query(source, 'UPDATE bench_probe SET writes = writes + 1 WHERE id = 1', true);
          await exportAndStore(source, measurement, observer);
        }
        await prepareRestoreFiles(measurement, observer);
        if (args.includes('--split-restore-tail') || measurement.restoreTailPreparation)
          await prepareRestoreTail(measurement, observer);
        observer.phase('recovery');
        await confirmBackup(measurement);
        assert.equal(measurement.backupConfirmed, true);
        assert.equal(measurement.preparedBackupConfirmed, true);
        const recoveryStart = clock();
        measurement.recoveryOriginalStartedAtMs ??= measurement.recoveryStartedAtMs;
        measurement.recoveryStartedAtMs = Date.now();
        if (index === sizes.length - 1 && repeat === repeats && !source.deleted) {
          measurement.sourceDeletedForRecovery = true;
          state.sourceRecoveryStarted = true;
          await save();
          log('Deleting only the disposable source to prove restoration without the original DB');
          const deleteStarted = clock();
          await deleteDatabase(source);
          try {
            await api(endpoint(source));
            throw new Error('Deleted source still exists');
          } catch (error) {
            assert.equal(error.status, 404, 'Source absence was not confirmed');
          }
          measurement.sourceAbsenceConfirmed = true;
          measurement.sourceDeletionMs = clock() - deleteStarted;
          await save();
        }
        let restore =
          (measurement.importCompleted || resumePartialImport) &&
          state.databases.find((entry) => entry.role === measurement.restoreRole && !entry.deleted);
        if (resumePartialImport) assert.ok(restore, 'Dedicated partial restore no longer exists');
        const resumedVerification = Boolean(restore) && !resumePartialImport;
        if (!restore) {
          const createStart = clock();
          restore = await createDatabase(
            `restore-${targetMiB}-${repeat}-${state.databases.length}`
          );
          measurement.databaseCreateMs = clock() - createStart;
          measurement.restoreRole = restore.role;
          measurement.importCompleted = false;
          delete measurement.importTotalMs;
          await save();
          measurement.workerDeployMs = await deployWorker(source, control, restore);
          await restoreFromR2(restore, measurement);
          measurement.importCompleted = true;
          await save();
        } else if (resumePartialImport) {
          measurement.resumeWorkerDeployMs = await deployWorker(source, control, restore);
          measurement.recoveryRemediationMs =
            (measurement.restoreTailPreparationMs ?? 0) + measurement.resumeWorkerDeployMs;
          await restoreFromR2(restore, measurement, {
            resumeFromPart: measurement.importResumeCheckpoint.completedPartCount,
          });
          measurement.importCompleted = true;
          await save();
        } else {
          log('Resuming verification of the already completed dedicated restore');
          measurement.resumeWorkerDeployMs = await deployWorker(source, control, restore);
        }
        const verifyStart = clock();
        await waitForeignKeyReadiness(restore, measurement);
        const restored = await fingerprint(query, restore, {
          accountCount: measurement.accountCount,
        });
        assert.deepEqual(
          restored,
          measurement.beforeFingerprint,
          'Restored Authrim counts/schema/aggregates/samples differ'
        );
        measurement.foreignKeyTablesChecked = await checkForeignKeys(restore);
        measurement.foreignKeyCheck = 'ok';
        measurement.quickCheckTablesChecked = await checkTables(restore);
        measurement.quickCheckMode =
          'per-table plus sqlite_schema; no global cross-table page-allocation check';
        measurement.quickCheck = 'ok';
        await workerJson('/read?target=restore');
        await workerJson('/write?target=restore', 'POST');
        measurement.restoredBindingReadWrite = true;
        measurement.verificationMs = clock() - verifyStart;
        measurement.recoveryTotalMs =
          resumedVerification || resumePartialImport
            ? (measurement.sourceDeletionMs ?? 0) +
              measurement.databaseCreateMs +
              measurement.workerDeployMs +
              (measurement.recoveryRemediationMs ?? 0) +
              measurement.importTotalMs +
              measurement.verificationMs
            : clock() - recoveryStart;
        measurement.recoveryTimingMode =
          resumedVerification || resumePartialImport
            ? 'sum completed provisioning/import/verification stages after resume'
            : 'continuous wall clock';
        measurement.recoveryFinishedAtMs = Date.now();
        if (measurement.recoveryOriginalStartedAtMs)
          measurement.recoveryWallTotalMs =
            measurement.recoveryFinishedAtMs - measurement.recoveryOriginalStartedAtMs;
        await delay(3000);
        measurement.probeSkips = await observer.stop();
        const allSamples = (
          await Promise.all(
            measurement.probeFiles.map(async (name) => {
              assert.match(name, /^r2-probes-[0-9.-]+\.ndjson$/);
              const contents = await readFile(path.join(runDir, name), 'utf8');
              return contents
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line));
            })
          )
        ).flat();
        measurement.probes = {
          baseline: summarizeProbes(
            observer.samples.filter(
              (s) => s.startedMs >= baselineStart && s.finishedMs <= baselineEnd
            ),
            baselineStart,
            baselineEnd
          ),
          export: measurement.exportReadyAtMs
            ? summarizeProbes(
                allSamples,
                measurement.exportStartedAtMs,
                measurement.exportReadyAtMs
              )
            : {},
          backupCopy: measurement.backupFinishedAtMs
            ? summarizeProbes(
                allSamples,
                measurement.exportReadyAtMs,
                measurement.rawBackupFinishedAtMs ?? measurement.backupFinishedAtMs
              )
            : {},
          backupPrepare: observer.samples.some((s) => s.phase === 'backupPrepare')
            ? summarizeProbes(
                observer.samples.filter((s) => s.phase === 'backupPrepare'),
                Math.min(
                  ...observer.samples
                    .filter((s) => s.phase === 'backupPrepare')
                    .map((s) => s.startedMs)
                ),
                Math.max(
                  ...observer.samples
                    .filter((s) => s.phase === 'backupPrepare')
                    .map((s) => s.finishedMs)
                )
              )
            : {},
          recovery: summarizeProbes(
            observer.samples,
            measurement.recoveryStartedAtMs,
            measurement.recoveryFinishedAtMs
          ),
        };
        measurement.verified = true;
        await save();
        await deleteDatabase(restore);
        log(
          `Verified ${targetMiB} MiB repeat ${repeat}; backup ${(measurement.backupTotalMs / 1000).toFixed(2)}s, import ${(measurement.importTotalMs / 1000).toFixed(2)}s, recovery including provisioning+verification ${(measurement.recoveryTotalMs / 1000).toFixed(2)}s`
        );
      } catch (error) {
        await observer.stop();
        measurement.error = safeError(error);
        await save();
        throw error;
      }
    }
  }
  await writeFile(
    path.join(directory, 'r2-results.json'),
    `${JSON.stringify(
      {
        runId,
        createdAt: state.createdAt,
        completedAt: new Date().toISOString(),
        profile: state.profile,
        methodology: {
          transport:
            'D1 raw export -> Worker -> private R2; private R2 -> Worker -> FK-wrapped SQL statement chunks in private R2; chunks -> Worker -> D1 import temporary R2 -> sequential ingest',
          dumpBytesThroughMac: 0,
          apiMinimumStartIntervalMs: 300,
          extraPollingDelayMs: 0,
          resumedImportPolling:
            '5s per poll, serial same-bookmark retries with 100ms delay; only polling requests are retried',
          workerCpuLimitMs: 300000,
          workerPartBytes: 8 * 1024 ** 2,
          probeCadenceMs: 1000,
          sourceDeletedOnlyAfterBackupManifest: true,
          restorationSql:
            'PRAGMA foreign_keys=OFF prefix and ON suffix per SQL-boundary chunk; full FK check after all chunks',
          postImportForeignKeys:
            'Separate final R2 SQL file containing only PRAGMA foreign_keys=ON and SELECT 1 imported after all data parts; require API+binding ON in three consecutive observations',
          restoreChunkTargetBytes: 1024 ** 3,
          quickCheck:
            'All application tables and sqlite_schema checked separately; global quick_check returned SQLITE_NOMEM on this schema',
          fingerprintQueryStrategy:
            'v2 forces existing primary-key range indexes and aggregates outbox once; coverage and hash semantics preserved; individual measurements identify legacy-v1 or v2',
        },
        measurements: state.measurements,
      },
      null,
      2
    )}\n`
  );
  if (!args.includes('--keep-resources')) await cleanup();
  log('R2 benchmark complete: r2-results.json');
}
try {
  await main();
} catch (error) {
  state.lastError = safeError(error);
  await save();
  log(`STOPPED: ${state.lastError}`);
  log(`Resume with --resume ${runId}`);
  process.exitCode = 1;
}
