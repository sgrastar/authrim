// Disposable benchmark Worker. Cloudflare API credentials stay with the local orchestrator.
// Required bindings: SOURCE, RESTORE, CONTROL, BACKUPS; secret: BENCH_TOKEN; var: RUN_PREFIX.
import { createHash, timingSafeEqual } from 'node:crypto';
import { SqlStreamSplitter } from './sql-stream-splitter.mjs';
import { createStatementClassifier } from './ddl-statement-classifier.mjs';

export const PART_BYTES = 8 * 1024 ** 2;
export const MAX_DUMP_BYTES = 5 * 1024 ** 3;
export const MAX_BACKUP_BYTES = 10 * 1024 ** 3;
const DEFAULT_RESTORE_CHUNK_BYTES = 1024 ** 3;
const FK_OFF = new TextEncoder().encode('PRAGMA foreign_keys=OFF;\n');
const FK_ON = new TextEncoder().encode('\nPRAGMA foreign_keys=ON;\n');
const FK_FINALIZER = new TextEncoder().encode('PRAGMA foreign_keys=ON;\nSELECT 1;\n');
const MAX_JSON_BYTES = 16 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 2 * 60 * 60 * 1000;

class BenchmarkError extends Error {
  constructor(code, status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function authenticated(request, secret) {
  const match = /^Bearer ([!-~]+)$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match || match[1].length > 1024) return false;
  return timingSafeEqual(
    createHash('sha256').update(secret).digest(),
    createHash('sha256').update(match[1]).digest()
  );
}

async function boundedJson(request) {
  if (!request.body) throw new BenchmarkError('INVALID_JSON', 400);
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JSON_BYTES) throw new BenchmarkError('REQUEST_TOO_LARGE', 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BenchmarkError('INVALID_JSON', 400);
    }
    return body;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof BenchmarkError) throw error;
    throw new BenchmarkError('INVALID_JSON', 400);
  } finally {
    reader.releaseLock();
  }
}

function ownedKey(key, runPrefix) {
  if (typeof runPrefix !== 'string' || !/^[a-z0-9][a-z0-9-]{0,159}\/?$/.test(runPrefix)) {
    throw new BenchmarkError('CONFIG_UNAVAILABLE');
  }
  const prefix = runPrefix.endsWith('/') ? runPrefix : `${runPrefix}/`;
  if (
    typeof key !== 'string' ||
    key.length > 1024 ||
    !key.startsWith(prefix) ||
    !/^[a-zA-Z0-9._/-]+$/.test(key.slice(prefix.length)) ||
    key.split('/').some((part) => part === '.' || part === '..' || part === '')
  ) {
    throw new BenchmarkError('INVALID_KEY', 400);
  }
  return key;
}

function presignedR2Url(value) {
  if (typeof value !== 'string' || value.length > 8192) {
    throw new BenchmarkError('INVALID_SIGNED_URL', 400);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BenchmarkError('INVALID_SIGNED_URL', 400);
  }
  // D1 export/import currently returns this exact official R2 account endpoint shape.
  const officialHost = /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/;
  if (
    url.protocol !== 'https:' ||
    !officialHost.test(url.hostname) ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.pathname === '/' ||
    url.searchParams.getAll('X-Amz-Signature').length !== 1 ||
    !/^[a-f0-9]{64}$/i.test(url.searchParams.get('X-Amz-Signature') ?? '') ||
    url.searchParams.getAll('X-Amz-Algorithm').length !== 1 ||
    url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256'
  ) {
    throw new BenchmarkError('INVALID_SIGNED_URL', 400);
  }
  return value;
}

function headEvidence(head) {
  return { size: head.size, etag: head.etag, uploadedAt: head.uploaded?.toISOString() ?? null };
}

function backupContext(context) {
  if (context === undefined) return undefined;
  if (!context || typeof context !== 'object' || Array.isArray(context))
    throw new BenchmarkError('INVALID_CONTEXT', 400);
  const result = {};
  for (const [name, value] of Object.entries(context)) {
    if (name === 'profile' && typeof value === 'string' && /^[a-zA-Z0-9._-]{1,160}$/.test(value))
      result[name] = value;
    else if (
      ['schemaSha256', 'fingerprintDigest'].includes(name) &&
      typeof value === 'string' &&
      /^[a-f0-9]{64}$/i.test(value)
    )
      result[name] = value.toLowerCase();
    else throw new BenchmarkError('INVALID_CONTEXT', 400);
  }
  return result;
}

async function backup(request, env, body, transferSignal, progress) {
  const key = ownedKey(body.key, env.RUN_PREFIX);
  const signedUrl = presignedR2Url(body.signedUrl);
  const started = performance.now();
  const signal = AbortSignal.any([
    request.signal,
    transferSignal,
    AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  ]);
  const response = await fetch(signedUrl, { redirect: 'manual', signal });
  const fetchHeadersMs = performance.now() - started;
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new BenchmarkError('EXPORT_DOWNLOAD_FAILED', 502);
  }
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BACKUP_BYTES) {
    await response.body.cancel();
    throw new BenchmarkError('DUMP_TOO_LARGE', 413);
  }
  const reader = response.body.getReader();
  const cancelRead = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancelRead, { once: true });
  let upload;
  let completed = false;
  try {
    const createStart = performance.now();
    upload = await env.BACKUPS.createMultipartUpload(key, {
      httpMetadata: { contentType: 'application/sql' },
      customMetadata: { benchmark: env.RUN_PREFIX },
    });
    const createMs = performance.now() - createStart;
    const md5 = createHash('md5');
    const sha256 = createHash('sha256');
    const parts = [];
    let buffer = new Uint8Array(PART_BYTES);
    let buffered = 0;
    let sizeBytes = 0;
    let readMs = 0;
    let uploadPartMs = 0;
    const streamStarted = performance.now();
    async function uploadBuffer(bytes) {
      signal.throwIfAborted();
      const partStarted = performance.now();
      parts.push(await upload.uploadPart(parts.length + 1, bytes));
      uploadPartMs += performance.now() - partStarted;
      progress({
        phase: 'multipart-upload',
        uploadedParts: parts.length,
        bytes: Math.min(parts.length * PART_BYTES, sizeBytes),
      });
    }
    while (true) {
      const readStarted = performance.now();
      const { value, done } = await reader.read();
      readMs += performance.now() - readStarted;
      signal.throwIfAborted();
      if (done) break;
      sizeBytes += value.byteLength;
      if (sizeBytes > MAX_BACKUP_BYTES) throw new BenchmarkError('DUMP_TOO_LARGE', 413);
      md5.update(value);
      sha256.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(PART_BYTES - buffered, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + take), buffered);
        buffered += take;
        offset += take;
        if (buffered === PART_BYTES) {
          await uploadBuffer(buffer);
          buffer = new Uint8Array(PART_BYTES);
          buffered = 0;
        }
      }
    }
    if (sizeBytes === 0) throw new BenchmarkError('EMPTY_DUMP', 422);
    if (buffered) await uploadBuffer(buffer.subarray(0, buffered));
    const streamMs = performance.now() - streamStarted;
    const completeStarted = performance.now();
    await upload.complete(parts);
    completed = true;
    const completeMs = performance.now() - completeStarted;
    const headStarted = performance.now();
    const head = await env.BACKUPS.head(key);
    const headMs = performance.now() - headStarted;
    if (!head || head.size !== sizeBytes) throw new BenchmarkError('BACKUP_SIZE_MISMATCH', 502);
    const manifestKey = `${key}.manifest.json`;
    const manifest = {
      key,
      sizeBytes,
      md5: md5.digest('hex'),
      sha256: sha256.digest('hex'),
      createdAt: new Date().toISOString(),
      parts: parts.length,
      objectEtag: head.etag,
      context: backupContext(body.context),
    };
    signal.throwIfAborted();
    const manifestStarted = performance.now();
    await env.BACKUPS.put(manifestKey, JSON.stringify(manifest), {
      httpMetadata: { contentType: 'application/json' },
    });
    const manifestMs = performance.now() - manifestStarted;
    return {
      key,
      manifestKey,
      sizeBytes,
      md5: manifest.md5,
      sha256: manifest.sha256,
      partBytes: PART_BYTES,
      parts: parts.length,
      fetchHeadersMs,
      createMs,
      streamMs,
      readMs,
      uploadPartMs,
      completeMs,
      headMs,
      manifestMs,
      totalMs: performance.now() - started,
      head: headEvidence(head),
    };
  } catch (error) {
    if (upload && !completed) await upload.abort().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelRead);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readManifest(env, key) {
  const object = await env.BACKUPS.get(`${key}.manifest.json`);
  if (!object || !object.body || object.size > MAX_JSON_BYTES) {
    await object?.body?.cancel().catch(() => {});
    throw new BenchmarkError('MANIFEST_UNAVAILABLE', 422);
  }
  let manifest;
  try {
    manifest = JSON.parse(await object.text());
  } catch {
    throw new BenchmarkError('INVALID_MANIFEST', 422);
  }
  if (
    !manifest ||
    manifest.key !== key ||
    !Number.isSafeInteger(manifest.sizeBytes) ||
    manifest.sizeBytes < 1 ||
    manifest.sizeBytes > MAX_BACKUP_BYTES ||
    !/^[a-f0-9]{32}$/.test(manifest.md5 ?? '') ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') ||
    typeof manifest.objectEtag !== 'string' ||
    !Number.isInteger(manifest.parts) ||
    manifest.parts < 1
  )
    throw new BenchmarkError('INVALID_MANIFEST', 422);
  return manifest;
}

function prepareOptions(body, env) {
  const key = ownedKey(body.key, env.RUN_PREFIX);
  const preparedPrefix = ownedKey(body.preparedPrefix ?? `${key}.restore`, env.RUN_PREFIX);
  if (preparedPrefix.length > 900 || key.startsWith(`${preparedPrefix}/`)) {
    throw new BenchmarkError('INVALID_PREPARED_PREFIX', 400);
  }
  if (
    !Number.isSafeInteger(body.expectedBytes) ||
    body.expectedBytes < 1 ||
    body.expectedBytes > MAX_BACKUP_BYTES
  ) {
    throw new BenchmarkError('INVALID_EXPECTED_BYTES', 400);
  }
  if (typeof body.expectedMd5 !== 'string' || !/^[a-f0-9]{32}$/i.test(body.expectedMd5)) {
    throw new BenchmarkError('INVALID_EXPECTED_MD5', 400);
  }
  if (
    body.expectedSha256 !== undefined &&
    (typeof body.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(body.expectedSha256))
  ) {
    throw new BenchmarkError('INVALID_EXPECTED_SHA256', 400);
  }
  const targetChunkBytes = body.targetChunkBytes ?? DEFAULT_RESTORE_CHUNK_BYTES;
  if (
    !Number.isSafeInteger(targetChunkBytes) ||
    targetChunkBytes < 1 ||
    targetChunkBytes > DEFAULT_RESTORE_CHUNK_BYTES
  ) {
    throw new BenchmarkError('INVALID_CHUNK_SIZE', 400);
  }
  return { key, preparedPrefix, targetChunkBytes };
}

function tailOptions(body, env) {
  const options = prepareOptions(body, env);
  if (
    !Array.isArray(body.populatedTables) ||
    body.populatedTables.length < 1 ||
    body.populatedTables.length > 128 ||
    body.populatedTables.some(
      (table) => typeof table !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(table)
    )
  ) {
    throw new BenchmarkError('INVALID_POPULATED_TABLES', 400);
  }
  const populatedTables = new Set(body.populatedTables.map((table) => table.toLowerCase()));
  if (populatedTables.size !== body.populatedTables.length)
    throw new BenchmarkError('INVALID_POPULATED_TABLES', 400);
  const emptyIndexGroupSize = body.emptyIndexGroupSize ?? 16;
  const triggerGroupSize = body.triggerGroupSize ?? 16;
  if (
    !Number.isSafeInteger(emptyIndexGroupSize) ||
    emptyIndexGroupSize < 1 ||
    emptyIndexGroupSize > 16 ||
    !Number.isSafeInteger(triggerGroupSize) ||
    triggerGroupSize < 1 ||
    triggerGroupSize > 16
  )
    throw new BenchmarkError('INVALID_DDL_GROUP_SIZE', 400);
  return { ...options, populatedTables, emptyIndexGroupSize, triggerGroupSize };
}

class PreparedMultipartWriter {
  constructor(env, key, signal, progress, { wrapper = true, kind } = {}) {
    this.env = env;
    this.key = key;
    this.signal = signal;
    this.progress = progress;
    this.wrapper = wrapper;
    this.kind = kind;
    this.buffer = new Uint8Array(PART_BYTES);
    this.buffered = 0;
    this.sizeBytes = 0;
    this.rawBytes = 0;
    this.statements = 0;
    this.parts = [];
    this.md5 = createHash('md5');
    this.sha256 = createHash('sha256');
  }

  async start() {
    this.signal.throwIfAborted();
    this.progress({ phase: 'prepare-object', key: this.key, bytes: 0 });
    // Remove a previous attempt's commit marker before replacing this deterministic key.
    await this.env.BACKUPS.delete(`${this.key}.manifest.json`);
    this.upload = await this.env.BACKUPS.createMultipartUpload(this.key, {
      httpMetadata: { contentType: 'application/sql' },
      customMetadata: { benchmark: this.env.RUN_PREFIX },
    });
    if (this.wrapper) await this.write(FK_OFF);
  }

  async flush() {
    if (!this.buffered) return;
    this.signal.throwIfAborted();
    this.parts.push(
      await this.upload.uploadPart(this.parts.length + 1, this.buffer.subarray(0, this.buffered))
    );
    this.progress({
      phase: 'prepare-multipart',
      key: this.key,
      bytes: this.sizeBytes,
      uploadedParts: this.parts.length,
    });
    this.buffer = new Uint8Array(PART_BYTES);
    this.buffered = 0;
  }

  async write(bytes, raw = false) {
    this.signal.throwIfAborted();
    if (
      this.sizeBytes + bytes.byteLength + (raw && this.wrapper ? FK_ON.byteLength : 0) >
      MAX_DUMP_BYTES
    ) {
      throw new BenchmarkError('RESTORE_STATEMENT_TOO_LARGE', 413);
    }
    this.md5.update(bytes);
    this.sha256.update(bytes);
    this.sizeBytes += bytes.byteLength;
    if (raw) this.rawBytes += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(PART_BYTES - this.buffered, bytes.byteLength - offset);
      this.buffer.set(bytes.subarray(offset, offset + take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === PART_BYTES) await this.flush();
    }
  }

  async finish(context, preparation) {
    if (this.wrapper) await this.write(FK_ON);
    await this.flush();
    this.signal.throwIfAborted();
    await this.upload.complete(this.parts);
    this.completed = true;
    const head = await this.env.BACKUPS.head(this.key);
    if (!head || head.size !== this.sizeBytes)
      throw new BenchmarkError('BACKUP_SIZE_MISMATCH', 502);
    const manifest = {
      key: this.key,
      sizeBytes: this.sizeBytes,
      md5: this.md5.digest('hex'),
      sha256: this.sha256.digest('hex'),
      createdAt: new Date().toISOString(),
      parts: this.parts.length,
      objectEtag: head.etag,
      context,
      preparation,
      ...(this.kind ? { kind: this.kind } : {}),
    };
    return {
      key: this.key,
      manifestKey: `${this.key}.manifest.json`,
      sizeBytes: this.sizeBytes,
      md5: manifest.md5,
      sha256: manifest.sha256,
      statements: this.statements,
      rawBytes: this.rawBytes,
      head: headEvidence(head),
      manifest,
      ...(this.kind ? { kind: this.kind } : {}),
    };
  }

  async abort() {
    if (this.upload && !this.completed) await this.upload.abort().catch(() => {});
  }
}

async function prepareRestore(request, env, body, transferSignal, progress, tail = false) {
  const options = tail ? tailOptions(body, env) : prepareOptions(body, env);
  const { key, preparedPrefix, targetChunkBytes } = options;
  const started = performance.now();
  const rawManifest = await readManifest(env, key);
  if (
    rawManifest.md5 !== body.expectedMd5.toLowerCase() ||
    rawManifest.sizeBytes !== body.expectedBytes ||
    (body.expectedSha256 !== undefined && rawManifest.sha256 !== body.expectedSha256.toLowerCase())
  ) {
    throw new BenchmarkError('MANIFEST_MISMATCH', 422);
  }
  if (
    tail &&
    (rawManifest.preparation?.foreignKeysDisabled !== true ||
      rawManifest.kind === 'foreign-key-finalizer')
  )
    throw new BenchmarkError('UNSAFE_TAIL_INPUT', 422);
  const raw = await env.BACKUPS.get(key);
  if (!raw || !raw.body) throw new BenchmarkError('BACKUP_NOT_FOUND', 404);
  if (raw.size !== rawManifest.sizeBytes || raw.etag !== rawManifest.objectEtag) {
    await raw.body.cancel().catch(() => {});
    throw new BenchmarkError('BACKUP_SIZE_MISMATCH', 422);
  }
  const signal = AbortSignal.any([
    request.signal,
    transferSignal,
    AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  ]);
  const reader = raw.body.getReader();
  const cancelRead = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancelRead, { once: true });
  const indexKey = `${preparedPrefix}/index.manifest.json`;
  const completed = [];
  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const encoder = new TextEncoder();
  // Tail input is an already committed, wrapped restore part. Its final FK ON is preserved.
  const splitter = new SqlStreamSplitter({ rejectForeignKeysEnable: !tail });
  let sizeBytes = 0;
  let statements = 0;
  let current;
  let classifier = tail ? createStatementClassifier() : undefined;
  let pending = [];
  let statementClassification;
  let statementSelected = false;
  let seenDdl = false;
  let currentDdlCount = 0;
  const tailPlan = tail
    ? {
        populatedTables: [...options.populatedTables],
        emptyIndexGroupSize: options.emptyIndexGroupSize,
        triggerGroupSize: options.triggerGroupSize,
      }
    : undefined;
  async function finishCurrent() {
    if (!current) return;
    const chunk = completed.length + 1;
    const evidence = await current.finish(rawManifest.context, {
      rawKey: key,
      rawMd5: rawManifest.md5,
      rawSha256: rawManifest.sha256,
      rawSizeBytes: rawManifest.sizeBytes,
      chunk,
      foreignKeysDisabled: current.wrapper,
      ...(current.kind ? { kind: current.kind } : {}),
      ...(tail ? { mode: 'tail-ddl', tailPlan } : {}),
    });
    completed.push(evidence);
    progress({
      phase: 'prepare-part-complete',
      key: evidence.key,
      manifestKey: evidence.manifestKey,
      bytes: evidence.sizeBytes,
      chunk,
    });
    current = undefined;
    currentDdlCount = 0;
  }
  async function startCurrent(kind) {
    if (completed.length >= 1023) throw new BenchmarkError('TOO_MANY_RESTORE_PARTS', 413);
    const outputKey = `${preparedPrefix}/${String(completed.length + 1).padStart(4, '0')}.sql`;
    current = new PreparedMultipartWriter(env, outputKey, signal, progress, { kind });
    await current.start();
  }
  async function selectTailStatement(classification) {
    statementClassification = classification;
    let kind;
    let limit;
    if (classification.kind === 'index') {
      seenDdl = true;
      const populated = options.populatedTables.has(classification.table.toLowerCase());
      kind = populated ? 'populated-index' : 'empty-indexes';
      limit = populated ? 1 : options.emptyIndexGroupSize;
    } else if (classification.kind === 'trigger') {
      seenDdl = true;
      kind = 'triggers';
      limit = options.triggerGroupSize;
    } else {
      kind = current?.kind ?? (seenDdl ? 'ddl-tail' : 'data-tail');
    }
    if (current && (current.kind !== kind || (limit && currentDdlCount >= limit)))
      await finishCurrent();
    if (!current) await startCurrent(kind);
    statementSelected = true;
    for (const text of pending) await current.write(encoder.encode(text), true);
    pending = [];
  }
  async function consumeTail(piece) {
    if (!statementSelected) {
      classifier.consume(piece.text);
      pending.push(piece.text);
      if (classifier.classification) await selectTailStatement(classifier.classification);
    } else {
      await current.write(encoder.encode(piece.text), true);
    }
    if (piece.boundary) {
      if (!statementSelected) await selectTailStatement(classifier.finish());
      current.statements++;
      statements++;
      if (statementClassification.kind === 'index' || statementClassification.kind === 'trigger')
        currentDdlCount++;
      classifier = createStatementClassifier();
      statementClassification = undefined;
      statementSelected = false;
    }
  }
  async function consume(pieces) {
    for (const piece of pieces) {
      if (!piece.text) continue;
      if (tail) {
        await consumeTail(piece);
        continue;
      }
      if (!current) {
        await startCurrent();
      }
      await current.write(encoder.encode(piece.text), true);
      if (piece.boundary) {
        current.statements++;
        statements++;
        if (current.rawBytes >= targetChunkBytes) await finishCurrent();
      }
    }
  }
  try {
    progress({ phase: 'prepare-index', key: indexKey, bytes: 0 });
    await env.BACKUPS.delete(indexKey);
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      sizeBytes += value.byteLength;
      if (sizeBytes > rawManifest.sizeBytes)
        throw new BenchmarkError('RAW_INTEGRITY_MISMATCH', 422);
      md5.update(value);
      sha256.update(value);
      await consume(splitter.push(decoder.decode(value, { stream: true })));
    }
    await consume(splitter.push(decoder.decode()));
    await consume(splitter.finish());
    if (tail && !statementSelected && pending.length)
      await selectTailStatement(classifier.finish());
    const actualMd5 = md5.digest('hex');
    const actualSha256 = sha256.digest('hex');
    if (
      sizeBytes !== rawManifest.sizeBytes ||
      actualMd5 !== rawManifest.md5 ||
      actualSha256 !== rawManifest.sha256
    ) {
      throw new BenchmarkError('RAW_INTEGRITY_MISMATCH', 422);
    }
    await finishCurrent();
    if (statements === 0 || completed.length === 0) throw new BenchmarkError('EMPTY_SQL_DUMP', 422);
    // D1 bulk import needs a separate final import to restore connection-level FK enforcement.
    const finalizerKey = `${preparedPrefix}/${String(completed.length + 1).padStart(4, '0')}.sql`;
    current = new PreparedMultipartWriter(env, finalizerKey, signal, progress, {
      wrapper: false,
      kind: 'foreign-key-finalizer',
    });
    await current.start();
    current.statements = 2;
    await current.write(FK_FINALIZER);
    await finishCurrent();
    statements += 2;
    // Commit chunk manifests only after the entire raw object has passed both hash checks.
    for (const part of completed) {
      signal.throwIfAborted();
      await env.BACKUPS.put(part.manifestKey, JSON.stringify(part.manifest), {
        httpMetadata: { contentType: 'application/json' },
      });
    }
    const parts = completed.map(({ manifest: _manifest, ...part }) => part);
    const result = {
      rawKey: key,
      rawBytes: sizeBytes,
      rawMd5: actualMd5,
      rawSha256: actualSha256,
      preparedPrefix,
      indexKey,
      targetChunkBytes,
      ...(tail ? { mode: 'tail-ddl', tailPlan } : {}),
      statements,
      parts,
      context: rawManifest.context,
      totalMs: performance.now() - started,
    };
    await env.BACKUPS.put(
      indexKey,
      JSON.stringify({ ...result, createdAt: new Date().toISOString() }),
      { httpMetadata: { contentType: 'application/json' } }
    );
    return result;
  } catch (error) {
    await current?.abort();
    if (error?.code === 'FOREIGN_KEYS_ENABLE_UNSUPPORTED')
      throw new BenchmarkError('FOREIGN_KEYS_ENABLE_UNSUPPORTED', 422);
    if (error instanceof SyntaxError || error?.code?.startsWith('SQL_SPLIT_'))
      throw new BenchmarkError('INVALID_SQL_STREAM', 422);
    if (error?.code?.startsWith('DDL_CLASSIFY_'))
      throw new BenchmarkError('INVALID_DDL_HEADER', 422);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelRead);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function preparedIndex(env, preparedPrefix) {
  ownedKey(preparedPrefix, env.RUN_PREFIX);
  const indexKey = `${preparedPrefix}/index.manifest.json`;
  const stored = await env.BACKUPS.get(indexKey);
  if (!stored || !stored.body) throw new BenchmarkError('PREPARED_INDEX_NOT_FOUND', 404);
  if (stored.size > MAX_INDEX_BYTES) {
    await stored.body.cancel().catch(() => {});
    throw new BenchmarkError('INVALID_PREPARED_INDEX', 422);
  }
  let index;
  try {
    index = JSON.parse(await stored.text());
  } catch {
    throw new BenchmarkError('INVALID_PREPARED_INDEX', 422);
  }
  if (
    !index ||
    index.preparedPrefix !== preparedPrefix ||
    index.indexKey !== indexKey ||
    !/^[a-f0-9]{32}$/.test(index.rawMd5 ?? '') ||
    !/^[a-f0-9]{64}$/.test(index.rawSha256 ?? '') ||
    !Number.isSafeInteger(index.rawBytes) ||
    index.rawBytes < 1 ||
    index.rawBytes > MAX_BACKUP_BYTES ||
    !Array.isArray(index.parts) ||
    index.parts.length < 1 ||
    index.parts.length > 1024
  ) {
    throw new BenchmarkError('INVALID_PREPARED_INDEX', 422);
  }
  ownedKey(index.rawKey, env.RUN_PREFIX);
  for (const [position, part] of index.parts.entries()) {
    const expectedKey = `${preparedPrefix}/${String(position + 1).padStart(4, '0')}.sql`;
    if (
      part.key !== expectedKey ||
      part.manifestKey !== `${expectedKey}.manifest.json` ||
      !Number.isSafeInteger(part.sizeBytes) ||
      part.sizeBytes < 1 ||
      part.sizeBytes > MAX_DUMP_BYTES ||
      !/^[a-f0-9]{32}$/.test(part.md5 ?? '') ||
      !/^[a-f0-9]{64}$/.test(part.sha256 ?? '')
    ) {
      throw new BenchmarkError('INVALID_PREPARED_INDEX', 422);
    }
    ownedKey(part.key, env.RUN_PREFIX);
  }
  return { indexKey, index };
}

async function restoreUpload(request, env, body, transferSignal, progress) {
  const key = ownedKey(body.key, env.RUN_PREFIX);
  const uploadUrl = presignedR2Url(body.uploadUrl);
  if (
    !Number.isSafeInteger(body.expectedBytes) ||
    body.expectedBytes < 1 ||
    body.expectedBytes > MAX_DUMP_BYTES
  ) {
    throw new BenchmarkError('INVALID_EXPECTED_BYTES', 400);
  }
  if (typeof body.expectedMd5 !== 'string' || !/^[a-f0-9]{32}$/i.test(body.expectedMd5)) {
    throw new BenchmarkError('INVALID_EXPECTED_MD5', 400);
  }
  const expectedMd5 = body.expectedMd5.toLowerCase();
  const started = performance.now();
  const manifest = await readManifest(env, key);
  if (manifest.md5 !== expectedMd5 || manifest.sizeBytes !== body.expectedBytes) {
    throw new BenchmarkError('MANIFEST_MISMATCH', 422);
  }
  const object = await env.BACKUPS.get(key);
  const getMs = performance.now() - started;
  if (!object || !object.body) throw new BenchmarkError('BACKUP_NOT_FOUND', 404);
  if (object.size !== body.expectedBytes || object.etag !== manifest.objectEtag) {
    await object.body.cancel().catch(() => {});
    throw new BenchmarkError('BACKUP_SIZE_MISMATCH', 422);
  }
  // A known-length stream is required: Workers derives Content-Length from the body type.
  const outgoing = new FixedLengthStream(body.expectedBytes);
  const writer = outgoing.writable.getWriter();
  const reader = object.body.getReader();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    request.signal,
    transferSignal,
    controller.signal,
    AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
  ]);
  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  let sizeBytes = 0;
  let actualMd5;
  let actualSha256;
  let lastProgressBytes = 0;
  const uploadStarted = performance.now();
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        sizeBytes += value.byteLength;
        if (sizeBytes > body.expectedBytes)
          throw new BenchmarkError('RESTORE_INTEGRITY_MISMATCH', 422);
        md5.update(value);
        sha256.update(value);
        await writer.write(value);
        if (sizeBytes - lastProgressBytes >= PART_BYTES) {
          progress({ phase: 'restore-upload', bytes: sizeBytes });
          lastProgressBytes = sizeBytes;
        }
      }
      actualMd5 = md5.digest('hex');
      actualSha256 = sha256.digest('hex');
      if (
        sizeBytes !== body.expectedBytes ||
        actualMd5 !== expectedMd5 ||
        actualSha256 !== manifest.sha256
      ) {
        throw new BenchmarkError('RESTORE_INTEGRITY_MISMATCH', 422);
      }
      await writer.close();
    } catch (error) {
      controller.abort();
      await writer.abort(error).catch(() => {});
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  })();
  const put = (async () => {
    try {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        redirect: 'manual',
        signal,
        headers: { 'Content-Length': String(body.expectedBytes) },
        body: outgoing.readable,
        duplex: 'half',
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new BenchmarkError('RESTORE_UPLOAD_FAILED', 502);
      const etag = response.headers.get('ETag')?.replace(/^"|"$/g, '').toLowerCase();
      if (etag !== expectedMd5) throw new BenchmarkError('RESTORE_ETAG_MISMATCH', 422);
      return etag;
    } catch (error) {
      controller.abort();
      await writer.abort(error).catch(() => {});
      await reader.cancel().catch(() => {});
      throw error;
    }
  })();
  const [pumped, uploaded] = await Promise.allSettled([pump, put]);
  if (pumped.status === 'rejected' || uploaded.status === 'rejected') {
    const errors = [pumped, uploaded]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    throw errors.find((error) => error instanceof BenchmarkError) ?? errors[0];
  }
  return {
    key,
    manifestKey: `${key}.manifest.json`,
    sizeBytes,
    md5: actualMd5,
    sha256: actualSha256,
    etag: uploaded.value,
    getMs,
    uploadMs: performance.now() - uploadStarted,
    totalMs: performance.now() - started,
    integrityVerified: true,
  };
}

function streamedTransfer(request, operation, execute) {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let timer;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
          abort.abort();
          clearInterval(timer);
        }
      };
      send({ type: 'started', operation });
      timer = setInterval(
        () => send({ type: 'heartbeat', operation, at: new Date().toISOString() }),
        10000
      );
      void (async () => {
        try {
          const evidence = await execute(abort.signal, (progress) =>
            send({ type: 'progress', operation, ...progress })
          );
          send({
            type: 'result',
            ok: true,
            operation,
            colo: request.cf?.colo ?? null,
            ...evidence,
          });
        } catch (error) {
          send({
            type: 'error',
            ok: false,
            operation,
            error: error instanceof BenchmarkError ? error.code : 'TRANSFER_UNAVAILABLE',
          });
        } finally {
          clearInterval(timer);
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      closed = true;
      clearInterval(timer);
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function probeMeta(meta = {}) {
  const allowed = [
    'duration',
    'changes',
    'rows_read',
    'rows_written',
    'size_after',
    'total_attempts',
    'served_by_region',
    'served_by_colo',
    'served_by_primary',
  ];
  const result = Object.fromEntries(
    allowed
      .filter((key) => ['number', 'boolean', 'string'].includes(typeof meta[key]))
      .map((key) => [key, meta[key]])
  );
  if (typeof meta.timings?.sql_duration_ms === 'number')
    result.timings = { sql_duration_ms: meta.timings.sql_duration_ms };
  return result;
}

async function probe(request, env, url) {
  const target = url.searchParams.get('target') ?? 'source';
  if (!['source', 'restore', 'control'].includes(target))
    throw new BenchmarkError('INVALID_TARGET', 400);
  const write = request.method === 'POST';
  const started = performance.now();
  const context = { operation: write ? 'write' : 'read', target, colo: request.cf?.colo ?? null };
  try {
    const binding = { source: 'SOURCE', restore: 'RESTORE', control: 'CONTROL' }[target];
    const result = await env[binding]
      .withSession('first-primary')
      .prepare(
        write
          ? 'UPDATE bench_probe SET writes = writes + 1 WHERE id = 1 RETURNING writes'
          : 'SELECT writes FROM bench_probe WHERE id = 1'
      )
      .all();
    const sqlWallMs = performance.now() - started;
    if (!result.success || result.results?.length !== 1) {
      return json({ ok: false, ...context, sqlWallMs, error: 'PROBE_NOT_READY' }, 503);
    }
    return json({ ok: true, ...context, sqlWallMs, meta: probeMeta(result.meta) });
  } catch {
    return json(
      { ok: false, ...context, sqlWallMs: performance.now() - started, error: 'D1_UNAVAILABLE' },
      503
    );
  }
}

async function foreignKeyMode(env, url) {
  const target = url.searchParams.get('target') ?? 'source';
  if (!['source', 'restore', 'control'].includes(target)) {
    throw new BenchmarkError('INVALID_TARGET', 400);
  }
  try {
    const binding = { source: 'SOURCE', restore: 'RESTORE', control: 'CONTROL' }[target];
    const result = await env[binding]
      .withSession('first-primary')
      .prepare('PRAGMA foreign_keys')
      .all();
    const foreignKeys = result.results?.[0]?.foreign_keys;
    if (
      !result.success ||
      result.results?.length !== 1 ||
      (foreignKeys !== 0 && foreignKeys !== 1)
    ) {
      return json({ ok: false, error: 'PROBE_NOT_READY' }, 503);
    }
    return json({ ok: true, foreignKeys });
  } catch {
    return json({ ok: false, error: 'D1_UNAVAILABLE' }, 503);
  }
}

export default {
  async fetch(request, env) {
    if (typeof env.BENCH_TOKEN !== 'string' || !env.BENCH_TOKEN)
      return json({ ok: false, error: 'AUTH_UNAVAILABLE' }, 503);
    if (!authenticated(request, env.BENCH_TOKEN))
      return json({ ok: false, error: 'UNAUTHORIZED' }, 401, { 'WWW-Authenticate': 'Bearer' });
    const url = new URL(request.url);
    const method = {
      '/backup': 'POST',
      '/restore-upload': 'POST',
      '/prepare-restore': 'POST',
      '/prepare-tail': 'POST',
      '/prepared': 'GET',
      '/foreign-key-mode': 'GET',
      '/read': 'GET',
      '/write': 'POST',
      '/probe': 'GET, POST',
      '/object': 'GET, DELETE',
    }[url.pathname];
    if (!method) return json({ ok: false, error: 'NOT_FOUND' }, 404);
    if (!method.split(', ').includes(request.method))
      return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: method });
    try {
      if (['/read', '/write', '/probe'].includes(url.pathname))
        return await probe(request, env, url);
      if (url.pathname === '/foreign-key-mode') return await foreignKeyMode(env, url);
      if (url.pathname === '/prepared') {
        return json({ ok: true, ...(await preparedIndex(env, url.searchParams.get('prefix'))) });
      }
      if (url.pathname === '/object') {
        const key = ownedKey(url.searchParams.get('key'), env.RUN_PREFIX);
        const manifestKey = `${key}.manifest.json`;
        if (request.method === 'DELETE') {
          await env.BACKUPS.delete([key, manifestKey]);
          return json({ ok: true, key, manifestKey, deleted: true });
        }
        const head = await env.BACKUPS.head(key);
        if (!head) throw new BenchmarkError('BACKUP_NOT_FOUND', 404);
        const manifest = await readManifest(env, key);
        return json({ ok: true, key, manifestKey, head: headEvidence(head), manifest });
      }
      const body = await boundedJson(request);
      ownedKey(body.key, env.RUN_PREFIX);
      if (url.pathname === '/prepare-tail') tailOptions(body, env);
      else if (url.pathname === '/prepare-restore') prepareOptions(body, env);
      else presignedR2Url(url.pathname === '/backup' ? body.signedUrl : body.uploadUrl);
      if (url.pathname === '/backup') backupContext(body.context);
      if (url.pathname === '/restore-upload') {
        if (
          !Number.isSafeInteger(body.expectedBytes) ||
          body.expectedBytes < 1 ||
          body.expectedBytes > MAX_DUMP_BYTES
        )
          throw new BenchmarkError('INVALID_EXPECTED_BYTES', 400);
        if (typeof body.expectedMd5 !== 'string' || !/^[a-f0-9]{32}$/i.test(body.expectedMd5))
          throw new BenchmarkError('INVALID_EXPECTED_MD5', 400);
      }
      return streamedTransfer(request, url.pathname.slice(1), (signal, progress) =>
        url.pathname === '/backup'
          ? backup(request, env, body, signal, progress)
          : ['/prepare-restore', '/prepare-tail'].includes(url.pathname)
            ? prepareRestore(request, env, body, signal, progress, url.pathname === '/prepare-tail')
            : restoreUpload(request, env, body, signal, progress)
      );
    } catch (error) {
      return json(
        { ok: false, error: error instanceof BenchmarkError ? error.code : 'TRANSFER_UNAVAILABLE' },
        error instanceof BenchmarkError ? error.status : 503
      );
    }
  },
};
