import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, unlink, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { schemaSql, seedSql, MAX_SEED_ROWS } from './fixture.mjs';
import { summarizeProbes } from './metrics.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const streamMode = args.includes('--stream');
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
}
const accountId = option('account-id', process.env.CLOUDFLARE_ACCOUNT_ID);
if (!/^[a-f0-9]{32}$/.test(accountId ?? '')) {
  throw new Error('Pass --account-id or CLOUDFLARE_ACCOUNT_ID (32 hex characters)');
}
const sizes = option('sizes', '100,1024,5120').split(',').map(Number);
const repeats = option('repeats', '3,1,1').split(',').map(Number);
if (
  !sizes.every((n) => Number.isFinite(n) && n > 0 && n <= 6000) ||
  !repeats.every((n) => Number.isInteger(n) && n > 0 && n <= 5)
) {
  throw new Error('Invalid --sizes (MiB, max 6000) or --repeats (1..5)');
}
const runId = option(
  'resume',
  `authrim-dump-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()}-${randomBytes(2).toString('hex')}`
);
if (!/^authrim-dump-[a-z0-9-]+$/.test(runId)) throw new Error('Invalid run ID');
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
    };
assert.equal(state.accountId, accountId);
const save = () => writeFile(journalPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
await save();
const log = (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
const ms = () => performance.now();
const cleanMessage = (value) =>
  String(value)
    .replace(/https?:\/\/\S+/g, '[URL]')
    .slice(0, 400);
let token = process.env.CLOUDFLARE_API_TOKEN;
const authFile = token
  ? null
  : option(
      'auth-file',
      process.platform === 'darwin'
        ? path.join(homedir(), 'Library/Preferences/.wrangler/config/default.toml')
        : path.join(homedir(), '.config/.wrangler/config/default.toml')
    );
let tokenExpiresAt = Infinity;
async function readOAuthFile() {
  const config = await readFile(authFile, 'utf8');
  token = config.match(/^oauth_token\s*=\s*"([^"\n]+)"/m)?.[1];
  tokenExpiresAt = Date.parse(config.match(/^expiration_time\s*=\s*"([^"\n]+)"/m)?.[1] ?? '');
  if (!token || !Number.isFinite(tokenExpiresAt)) {
    throw new Error('Wrangler OAuth file is missing a token or expiration time');
  }
}
if (authFile) await readOAuthFile();
if (!token)
  throw new Error('Run pnpm exec wrangler whoami to refresh OAuth, or set CLOUDFLARE_API_TOKEN');

let authRefresh;
let nextAuthCheckAt = 0;
async function ensureToken(force = false) {
  if (!authFile || (!force && Date.now() < Math.min(tokenExpiresAt - 60000, nextAuthCheckAt)))
    return;
  if (authRefresh) return authRefresh;
  authRefresh = (async () => {
    // Pick up a token refreshed by another Wrangler process before approaching expiry.
    await readOAuthFile();
    nextAuthCheckAt = Date.now() + 30000;
    if (!force && tokenExpiresAt > Date.now()) return;
    const executable = path.resolve(directory, '../../node_modules/wrangler/bin/wrangler.js');
    const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' };
    // Environment credentials bypass Wrangler's stored-OAuth refresh path.
    for (const name of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY'])
      delete env[name];
    const child = spawn(process.execPath, [executable, 'whoami'], {
      cwd: runDir,
      env,
      stdio: 'ignore',
      timeout: 60000,
    });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) throw new Error('Wrangler could not refresh stored OAuth credentials');
    await readOAuthFile();
    if (tokenExpiresAt <= Date.now()) throw new Error('Stored OAuth token remains expired');
    log('Reloaded Wrangler OAuth credentials');
  })();
  try {
    await authRefresh;
  } finally {
    authRefresh = undefined;
  }
}

async function api(
  endpoint,
  { method = 'GET', body, timeoutMs = 120000, retry = method === 'GET' } = {}
) {
  let transientAttempts = 0;
  let authRetried = false;
  for (;;) {
    await ensureToken();
    let response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/${endpoint}`,
        {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        }
      );
      const json = await response.json().catch(() => null);
      if (response.status === 401 && authFile && !authRetried) {
        authRetried = true;
        await ensureToken(true);
        continue;
      }
      if (!response.ok || !json || json.success === false) {
        const error = new Error(
          `API ${method} ${endpoint.split('/').at(-1)} HTTP ${response.status}: ${cleanMessage(JSON.stringify(json?.errors ?? { error: 'Invalid API response' }))}`
        );
        error.status = response.status;
        throw error;
      }
      return json.result;
    } catch (error) {
      const transient =
        [408, 429, 500, 502, 503, 504].includes(error.status) ||
        error.name === 'TypeError' ||
        error.name === 'TimeoutError';
      if (!retry || !transient || transientAttempts >= 3) throw error;
      const retryAfter = Number(response?.headers.get('retry-after'));
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** transientAttempts;
      if (waitMs > 30000) throw error; // Do not silently abandon an export's polling lease.
      transientAttempts++;
      log(`Retrying transient API failure (${transientAttempts}/3)`);
      await delay(waitMs);
    }
  }
}
function ownedDatabase(db) {
  assert.ok(state.databases.some((entry) => entry.uuid === db.uuid && entry.name === db.name));
  assert.ok(db.name.startsWith(`${runId}-`));
  return `d1/database/${db.uuid}`;
}
async function createDatabase(role) {
  const name = `${runId}-${role}`;
  log(`Creating dedicated ${role} D1`);
  const db = await api('d1/database', {
    method: 'POST',
    body: { name, primary_location_hint: 'apac' },
  });
  state.databases.push({ uuid: db.uuid, name, role, deleted: false });
  await save();
  return state.databases.at(-1);
}
async function deleteDatabase(db) {
  if (db.deleted) return;
  const endpoint = ownedDatabase(db);
  try {
    const current = await api(endpoint);
    assert.equal(current.name, db.name, 'Refusing to delete a database with an unexpected name');
    await api(endpoint, { method: 'DELETE' });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  db.deleted = true;
  await save();
  log(`Deleted dedicated ${db.role} D1`);
}
async function query(db, sql, { retry = false } = {}) {
  const results = await api(`${ownedDatabase(db)}/query`, { method: 'POST', body: { sql }, retry });
  const failed = results.filter((result) => !result.success);
  if (failed.length) {
    throw new Error(
      `D1 query failed: ${cleanMessage(JSON.stringify(failed.map((result) => result.error ?? result.errors ?? 'unknown error')))}`
    );
  }
  return results;
}
async function cleanup() {
  if (state.workerName && !state.workerDeleted) {
    assert.equal(state.workerName, runId);
    try {
      await api(`workers/scripts/${state.workerName}`, { method: 'DELETE' });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    state.workerDeleted = true;
    await save();
    log('Deleted dedicated probe Worker');
  }
  for (const db of state.databases) await deleteDatabase(db);
  state.cleanedUpAt = new Date().toISOString();
  await save();
}
if (args.includes('--cleanup')) {
  if (!option('resume')) throw new Error('--cleanup requires --resume RUN_ID');
  await cleanup();
  process.exit(0);
}

async function wrangler(commandArgs, logName) {
  await ensureToken();
  const executable = path.resolve(directory, '../../node_modules/wrangler/bin/wrangler.js');
  const child = spawn(process.execPath, [executable, ...commandArgs], {
    cwd: runDir,
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: token,
      WRANGLER_LOG_PATH: path.join(runDir, 'wrangler.log'),
      WRANGLER_SEND_METRICS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output += chunk;
    });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  await writeFile(path.join(runDir, `${logName}.txt`), output, { mode: 0o600 });
  if (code !== 0)
    throw new Error(`Wrangler ${commandArgs[0]} failed: ${cleanMessage(output.slice(-1500))}`);
  return output;
}
async function deployProbe(source, control) {
  const secret = randomBytes(32).toString('hex');
  const configPath = path.join(runDir, 'wrangler.jsonc');
  const secretsPath = path.join(runDir, 'secrets.json');
  await writeFile(
    configPath,
    JSON.stringify(
      {
        name: runId,
        account_id: accountId,
        main: path.join(directory, 'probe-worker.mjs'),
        compatibility_date: '2026-10-16',
        workers_dev: true,
        preview_urls: false,
        observability: { enabled: false },
        d1_databases: [source, control].map((db, index) => ({
          binding: index === 0 ? 'DB' : 'CONTROL',
          database_name: db.name,
          database_id: db.uuid,
        })),
      },
      null,
      2
    )
  );
  await writeFile(secretsPath, JSON.stringify({ BENCH_TOKEN: secret }), { mode: 0o600 });
  await wrangler(
    ['types', '--config', configPath, path.join(runDir, 'worker-configuration.d.ts')],
    'types'
  );
  await wrangler(['deploy', '--config', configPath, '--dry-run'], 'dry-run');
  // Journal before deployment so cleanup is possible after an unknown deployment outcome.
  state.workerName = runId;
  await save();
  const output = await wrangler(
    ['deploy', '--config', configPath, '--secrets-file', secretsPath],
    'deploy'
  );
  await unlink(secretsPath);
  const url = output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  if (!url) throw new Error('No workers.dev URL found in deploy output');
  state.probeUrl = url;
  await save();
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`${url}/read?target=control`, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) return { url, secret };
    } catch {
      /* Allow workers.dev propagation. */
    }
    await delay(2000);
  }
  throw new Error('Probe Worker did not become available');
}

async function growSource(source, targetMiB) {
  const targetBytes = targetMiB * 1024 ** 2;
  let result = (
    await query(source, 'SELECT count(*) AS n FROM bench_accounts', { retry: true })
  )[0];
  let nextId = result.results[0].n + 1;
  let sizeBytes = result.meta.size_after;
  const seedStart = ms();
  let lastLog = 0;
  while (sizeBytes < targetBytes) {
    // Four bounded statements amortize API overhead; cap near the requested size.
    const batches = Math.min(
      4,
      Math.max(1, Math.ceil((targetBytes - sizeBytes) / (MAX_SEED_ROWS * 1400)))
    );
    const sql = Array.from({ length: batches }, () => {
      const statement = seedSql(nextId, MAX_SEED_ROWS, 1024);
      nextId += MAX_SEED_ROWS;
      return statement;
    }).join('\n');
    // INSERT OR IGNORE with these exact ID ranges is safe after an ambiguous response.
    result = (await query(source, sql, { retry: true })).at(-1);
    sizeBytes = result.meta.size_after;
    if (ms() - lastLog > 15000 || sizeBytes >= targetBytes) {
      log(`Seed ${targetMiB} MiB: ${(sizeBytes / 1024 ** 2).toFixed(1)} MiB, ${nextId - 1} rows`);
      lastLog = ms();
    }
    await delay(250);
  }
  const info = await api(ownedDatabase(source));
  return {
    targetMiB,
    sizeBytes,
    rows: nextId - 1,
    seedMs: ms() - seedStart,
    primaryLocation: info.primary_location ?? info.primary_location_hint ?? null,
    fileSize: info.file_size ?? null,
  };
}

function startProbes(probe, samples, file) {
  let stopping = false;
  const pending = new Set();
  const inflight = new Map();
  const skippedBySeries = {};
  let skipped = 0;
  const tasks = [
    ['source', 'read'],
    ['source', 'write'],
    ['control', 'read'],
  ];
  async function one(target, operation) {
    const startedMs = Date.now();
    const start = ms();
    let sample;
    try {
      const response = await fetch(`${probe.url}/${operation}?target=${target}`, {
        method: operation === 'write' ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${probe.secret}` },
        signal: AbortSignal.timeout(90000),
      });
      const body = await response.json();
      sample = {
        status: response.status,
        ok: response.ok && body.ok,
        sqlWallMs: body.sqlWallMs,
        colo: body.colo,
        meta: body.meta,
        error: body.error,
      };
    } catch (error) {
      sample = { ok: false, timeout: error.name === 'TimeoutError', error: error.name };
    }
    sample = {
      target,
      operation,
      startedMs,
      finishedMs: Date.now(),
      elapsedMs: ms() - start,
      ...sample,
    };
    samples.push(sample);
    file.write(`${JSON.stringify(sample)}\n`);
  }
  function tick() {
    if (stopping) return;
    // Fixed cadence avoids hiding stalls behind a serial probe; bounded concurrency avoids pileups.
    for (const [target, operation] of tasks) {
      const series = `${target}/${operation}`;
      if ((inflight.get(series) ?? 0) >= 8) {
        skipped++;
        skippedBySeries[series] = (skippedBySeries[series] ?? 0) + 1;
        continue;
      }
      inflight.set(series, (inflight.get(series) ?? 0) + 1);
      const task = one(target, operation);
      pending.add(task);
      task.finally(() => {
        pending.delete(task);
        inflight.set(series, inflight.get(series) - 1);
      });
    }
  }
  tick();
  const timer = setInterval(tick, 1000);
  return async () => {
    stopping = true;
    clearInterval(timer);
    await Promise.allSettled([...pending]);
    return { skipped, skippedBySeries };
  };
}

async function exportDatabase(source, dumpPath, measurement) {
  const started = ms();
  measurement.exportStartedAtMs = Date.now();
  let response;
  let polls = 0;
  do {
    response = await api(`${ownedDatabase(source)}/export`, {
      method: 'POST',
      body: { output_format: 'polling', current_bookmark: response?.at_bookmark },
      // Repeating an existing bookmark polls the same job; never retry its initial creation.
      retry: Boolean(response?.at_bookmark),
    });
    polls++;
    if (response.status === 'error' || response.success === false)
      throw new Error(`Export failed: ${cleanMessage(response.error)}`);
    if (ms() - started > 7200000) throw new Error('Export exceeded two hours');
    if (response.status !== 'complete') await delay(250);
  } while (response.status !== 'complete');
  measurement.exportReadyAtMs = Date.now();
  measurement.exportApiMs = ms() - started;
  measurement.exportPolls = polls;
  measurement.downloadMode = streamMode ? 'stream-discard' : 'local-file';
  // Persist generation timing even if the following multi-GiB transfer fails.
  await save();
  const downloadStart = ms();
  const download = await fetch(response.result.signed_url, {
    signal: AbortSignal.timeout(7200000),
  });
  if (!download.ok) throw new Error(`Download failed HTTP ${download.status}`);
  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  let bytes = 0;
  let sinceCheck = 0;
  let lastProgressAt = ms();
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      sinceCheck += chunk.length;
      md5.update(chunk);
      sha256.update(chunk);
      if (ms() - lastProgressAt >= 30000) {
        log(`Export download ${(bytes / 1024 ** 2).toFixed(1)} MiB transferred`);
        lastProgressAt = ms();
      }
      if (!streamMode && sinceCheck > 64 * 1024 ** 2) {
        sinceCheck = 0;
        statfs(runDir).then((fs) => {
          if (fs.bavail * fs.bsize < 512 * 1024 ** 2)
            callback(new Error('Less than 512 MiB disk remains'));
          else callback(null, chunk);
        }, callback);
      } else callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(download.body),
    counter,
    streamMode
      ? new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        })
      : createWriteStream(dumpPath, { mode: 0o600 })
  );
  measurement.downloadMs = ms() - downloadStart;
  measurement.exportTotalMs = ms() - started;
  measurement.dumpBytes = bytes;
  measurement.dumpSha256 = sha256.digest('hex');
  measurement.exportFinishedAtMs = Date.now();
  await save();
  // Signed URLs remain in memory only, and must never enter the resource journal.
  return {
    etag: md5.digest('hex'),
    signedUrl: streamMode ? response.result.signed_url : undefined,
  };
}

async function importDatabase(restore, dumpPath, etag, measurement, signedUrl) {
  const start = ms();
  measurement.importStartedAtMs = Date.now();
  if (measurement.dumpBytes > 5 * 1024 ** 3) throw new Error('Dump exceeds D1 5 GiB import limit');
  const initStart = ms();
  let response = await api(`${ownedDatabase(restore)}/import`, {
    method: 'POST',
    body: { action: 'init', etag },
  });
  measurement.importInitMs = ms() - initStart;
  if (response.upload_url) {
    const uploadStart = ms();
    let uploadBody;
    let transferBytes = 0;
    let transferHash;
    if (signedUrl) {
      measurement.restoreTransferMode = 'signed-url-via-client';
      measurement.uploadTimingIncludes = 'second export download and PUT overlap via client';
      const download = await fetch(signedUrl, { signal: AbortSignal.timeout(7200000) });
      if (!download.ok) throw new Error(`Restore source download failed HTTP ${download.status}`);
      transferHash = createHash('md5');
      let lastProgressAt = ms();
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          transferBytes += chunk.length;
          transferHash.update(chunk);
          if (ms() - lastProgressAt >= 30000) {
            log(`Restore relay ${(transferBytes / 1024 ** 2).toFixed(1)} MiB transferred`);
            lastProgressAt = ms();
          }
          callback(null, chunk);
        },
      });
      const source = Readable.fromWeb(download.body);
      source.on('error', (error) => counter.destroy(error));
      counter.on('close', () => source.destroy());
      uploadBody = source.pipe(counter);
    } else {
      measurement.restoreTransferMode = 'local-file';
      uploadBody = createReadStream(dumpPath);
    }
    try {
      const upload = await fetch(response.upload_url, {
        method: 'PUT',
        headers: { 'Content-Length': String(measurement.dumpBytes) },
        body: uploadBody,
        duplex: 'half',
        signal: AbortSignal.timeout(7200000),
      });
      if (!upload.ok) throw new Error(`Import upload failed HTTP ${upload.status}`);
      assert.equal(
        upload.headers.get('etag')?.replaceAll('"', ''),
        etag,
        'Uploaded dump MD5 mismatch'
      );
      if (signedUrl) {
        assert.equal(transferBytes, measurement.dumpBytes, 'Relayed dump byte count mismatch');
        assert.equal(transferHash.digest('hex'), etag, 'Relayed dump MD5 mismatch');
      }
    } finally {
      uploadBody.destroy();
    }
    measurement.uploadMs = ms() - uploadStart;
    await save();
    const ingestStart = ms();
    response = await api(`${ownedDatabase(restore)}/import`, {
      method: 'POST',
      body: { action: 'ingest', filename: response.filename, etag },
    });
    measurement.ingestStartedAtMs = Date.now() - (ms() - ingestStart);
  } else {
    measurement.uploadMs = 0;
    measurement.uploadReused = true;
    measurement.ingestStartedAtMs = measurement.importStartedAtMs;
  }
  let polls = 0;
  while (response.status !== 'complete') {
    if (response.status === 'error' || response.success === false)
      throw new Error(`Import failed: ${cleanMessage(response.error ?? response.errors)}`);
    if (ms() - start > 14400000) throw new Error('Import exceeded four hours');
    await delay(250);
    response = await api(`${ownedDatabase(restore)}/import`, {
      method: 'POST',
      body: { action: 'poll', current_bookmark: response.at_bookmark },
      retry: true,
    });
    polls++;
  }
  measurement.importFinishedAtMs = Date.now();
  measurement.ingestObservedMs = measurement.importFinishedAtMs - measurement.ingestStartedAtMs;
  measurement.importTotalMs = ms() - start;
  measurement.importPolls = polls;
  measurement.importMeta = response.result?.meta;
  measurement.importNumQueries = response.result?.num_queries;
  await save();
}

async function fingerprint(db) {
  const read = async (sql) => (await query(db, sql, { retry: true }))[0].results[0];
  const bounds = await read(`SELECT
    (SELECT id FROM bench_accounts ORDER BY id LIMIT 1) AS min_id,
    (SELECT id FROM bench_accounts ORDER BY id DESC LIMIT 1) AS max_id`);
  const combined = {
    account_count: 0,
    min_id: bounds.min_id,
    max_id: bounds.max_id,
    id_sum: 0,
    updated_at_sum: 0,
    payload_bytes: 0,
    min_payload_bytes: null,
    max_payload_bytes: null,
  };
  // Bound every payload scan to 100k IDs (~140 MiB with this fixture), avoiding one
  // multi-GiB REST query subject to D1's 30-second request deadline.
  if (bounds.min_id !== null) {
    for (let first = bounds.min_id; first <= bounds.max_id; first += 100000) {
      const last = Math.min(first + 99999, bounds.max_id);
      const chunk = await read(`SELECT COUNT(*) AS account_count,
        COALESCE(SUM(id), 0) AS id_sum,
        COALESCE(SUM(updated_at), 0) AS updated_at_sum,
        COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS payload_bytes,
        MIN(length(CAST(payload AS BLOB))) AS min_payload_bytes,
        MAX(length(CAST(payload AS BLOB))) AS max_payload_bytes
        FROM bench_accounts WHERE id BETWEEN ${first} AND ${last}`);
      for (const key of ['account_count', 'id_sum', 'updated_at_sum', 'payload_bytes']) {
        combined[key] += chunk[key];
        assert.ok(Number.isSafeInteger(combined[key]), `Unsafe verification aggregate: ${key}`);
      }
      if (chunk.min_payload_bytes !== null) {
        combined.min_payload_bytes =
          combined.min_payload_bytes === null
            ? chunk.min_payload_bytes
            : Math.min(combined.min_payload_bytes, chunk.min_payload_bytes);
        combined.max_payload_bytes =
          combined.max_payload_bytes === null
            ? chunk.max_payload_bytes
            : Math.max(combined.max_payload_bytes, chunk.max_payload_bytes);
      }
    }
  }
  const samples = await read(`SELECT json_group_array(json_object(
      'id', id, 'tenant', tenant, 'email', email, 'status', status,
      'updated_at', updated_at, 'payload', payload
    )) AS sample_rows FROM (
      SELECT * FROM bench_accounts WHERE id IN (
        SELECT id FROM bench_accounts ORDER BY id LIMIT 3
      ) OR id IN (
        SELECT id FROM bench_accounts ORDER BY id DESC LIMIT 3
      ) ORDER BY id
    )`);
  return [{ ...combined, sample_rows: samples.sample_rows }];
}

async function main() {
  log(`Run ${runId}; requested MiB ${sizes.join(',')}`);
  const source =
    state.databases.find((db) => db.role === 'source' && !db.deleted) ??
    (await createDatabase('source'));
  const control =
    state.databases.find((db) => db.role === 'control' && !db.deleted) ??
    (await createDatabase('control'));
  if (!state.schemaReady) {
    await query(source, schemaSql, { retry: true });
    await query(control, schemaSql, { retry: true });
    await query(control, seedSql(1, 1, 1024), { retry: true });
    state.schemaReady = true;
    await save();
  }
  const probe = await deployProbe(source, control);
  log('Dedicated authenticated probe Worker ready');
  for (let i = 0; i < sizes.length; i++) {
    const targetMiB = sizes[i];
    const totalRepeats = repeats[i] ?? repeats.at(-1);
    const dataset = await growSource(source, targetMiB);
    for (let repeat = 1; repeat <= totalRepeats; repeat++) {
      if (
        state.measurements.some(
          (m) => m.targetMiB === targetMiB && m.repeat === repeat && m.verified
        )
      )
        continue;
      const measurement = { ...dataset, repeat, measuredAt: new Date().toISOString() };
      state.measurements.push(measurement);
      await save();
      const dumpPath = path.join(runDir, 'dump.sql');
      const before = await fingerprint(source);
      const samples = [];
      const probeFile = createWriteStream(
        path.join(runDir, `probes-${targetMiB}-${repeat}.ndjson`),
        { mode: 0o600 }
      );
      const stopProbes = startProbes(probe, samples, probeFile);
      log(`${targetMiB} MiB repeat ${repeat}: baseline probes (10 seconds)`);
      const baselineStart = Date.now();
      await delay(10000);
      const baselineEnd = Date.now();
      try {
        log(`${targetMiB} MiB repeat ${repeat}: exporting`);
        const exported = await exportDatabase(source, dumpPath, measurement);
        log(
          `Export ready ${(measurement.exportApiMs / 1000).toFixed(2)}s; downloaded ${(measurement.dumpBytes / 1024 ** 2).toFixed(2)} MiB in ${(measurement.downloadMs / 1000).toFixed(2)}s`
        );
        await delay(5000);
        const recoveryEnd = Date.now();
        measurement.probeScheduling = await stopProbes();
        measurement.probes = {
          baseline: summarizeProbes(
            samples.filter(
              (sample) => sample.startedMs >= baselineStart && sample.finishedMs <= baselineEnd
            ),
            baselineStart,
            baselineEnd
          ),
          export: summarizeProbes(
            samples,
            measurement.exportStartedAtMs,
            measurement.exportReadyAtMs
          ),
          download: summarizeProbes(
            samples,
            measurement.exportReadyAtMs,
            measurement.exportFinishedAtMs
          ),
          recovery: summarizeProbes(samples, measurement.exportFinishedAtMs, recoveryEnd),
        };
        probeFile.end();
        await save();
        const restore = await createDatabase(
          `restore-${targetMiB}-${repeat}-${state.measurements.length}`
        );
        log(`${targetMiB} MiB repeat ${repeat}: importing into empty dedicated D1`);
        await importDatabase(restore, dumpPath, exported.etag, measurement, exported.signedUrl);
        log(
          `Import upload ${(measurement.uploadMs / 1000).toFixed(2)}s; ingest ${(measurement.ingestObservedMs / 1000).toFixed(2)}s; total ${(measurement.importTotalMs / 1000).toFixed(2)}s`
        );
        const validationStart = ms();
        const restored = await fingerprint(restore);
        assert.deepEqual(restored, before, 'Restored row aggregates / payload samples differ');
        try {
          const integrity = (await query(restore, 'PRAGMA quick_check'))[0].results;
          assert.ok(integrity.every((row) => Object.values(row).every((value) => value === 'ok')));
          measurement.quickCheck = 'ok';
        } catch (error) {
          // The independent bounded row verification above must pass. A full-database
          // integrity scan can exceed D1's REST deadline even when restoration is valid.
          if (!/time.?out|timed out|time limit|duration|HTTP 524/i.test(error.message)) throw error;
          measurement.quickCheck = 'incomplete';
          measurement.quickCheckWarning = cleanMessage(error.message);
          log(
            'Full-database quick_check hit its request deadline; bounded account verification passed'
          );
        }
        measurement.verificationMs = ms() - validationStart;
        measurement.verified = true;
        measurement.fingerprint = restored;
        await save();
        await deleteDatabase(restore);
        if (!streamMode) await unlink(dumpPath);
        log(
          `${targetMiB} MiB repeat ${repeat}: restore verified${streamMode ? '; diskless transfer complete' : '; local dump removed'}`
        );
      } catch (error) {
        await stopProbes();
        probeFile.end();
        measurement.error = cleanMessage(error.message);
        await save();
        throw error;
      }
    }
  }
  const result = {
    runId,
    createdAt: state.createdAt,
    completedAt: new Date().toISOString(),
    methodology: {
      sizeUnit: 'MiB = 2^20 bytes, D1 meta.size_after',
      payloadBytes: 1024,
      dataset: 'Synthetic indexed account records; randomized hex TEXT payload',
      transport: 'Cloudflare official export/import REST protocol used by Wrangler 4.148.0',
      probeCadenceMs: 1000,
      probeMaxInflight: 24,
      probeMaxInflightPerSeries: 8,
      probeTimeoutMs: 90000,
      locationHint: 'apac',
      repetitions: repeats,
      cliStartupIncluded: false,
      verificationChunkMaxIds: 100000,
    },
    measurements: state.measurements,
  };
  await writeFile(path.join(directory, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (!args.includes('--keep-resources')) await cleanup();
  log(`Complete. Sanitized results: ${path.join(directory, 'results.json')}`);
}

try {
  await main();
} catch (error) {
  state.lastError = cleanMessage(error.message);
  await save();
  log(`STOPPED: ${state.lastError}`);
  log(`Resume using --resume ${runId}; cleanup using --resume ${runId} --cleanup`);
  process.exitCode = 1;
}
