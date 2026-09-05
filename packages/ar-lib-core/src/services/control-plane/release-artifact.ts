import type { R2Bucket } from '@cloudflare/workers-types';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const STREAM_ID_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const MAX_STREAM_ID_BYTES = 255;
const RELEASE_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u;
const PRODUCT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MIGRATION_PATH_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._/-]*\.sql$/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SQL_OBJECT_BYTES = 1024 * 1024;
const MAX_RELEASE_SQL_BYTES = 16 * 1024 * 1024;
const MAX_STREAMS = 32;
const MAX_FILES_PER_STREAM = 512;

export interface MigrationReleasePin {
  environmentId: string;
  streamId: string;
  releaseId: string;
  manifestDigest: string;
  manifestObjectKey: string;
  sourceProductVersion?: string;
}

export interface MigrationArtifactFile {
  path: string;
  checksum: string;
  sql: string;
  supersedes?: ManifestFile[];
}

export interface LoadedMigrationRelease {
  pin: MigrationReleasePin;
  productVersion: string;
  rollout: MigrationReleaseRolloutPolicy;
  files: MigrationArtifactFile[];
  knownHistory: ManifestFile[];
}

export interface MigrationReleaseRolloutPolicy {
  databaseExecution: 'setup_then_control';
  workerActivation: 'after_required_databases';
  adminMutationMode: 'available' | 'read_only';
  databaseOnly?: {
    compatibleWorkerVersions: string[];
  };
}

export interface ReleaseArtifactObject {
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ReleaseArtifactStore {
  get(key: string): Promise<ReleaseArtifactObject | null>;
}

export interface MigrationArtifactReaderLimits {
  maxManifestBytes?: number;
  maxSqlObjectBytes?: number;
  maxReleaseSqlBytes?: number;
}

interface ManifestFile {
  path: string;
  checksum: string;
  supersedes?: ManifestFile[];
}

interface ManifestStream {
  id: string;
  dialect: 'sqlite' | 'postgres' | 'mysql';
  files: ManifestFile[];
}

interface MigrationManifest {
  formatVersion: 1;
  productVersion: string;
  rollout: MigrationReleaseRolloutPolicy;
  streams: ManifestStream[];
  upgradePaths?: Array<{
    fromProductVersion: string;
    kind: 'delta' | 'bridge';
    streams: ManifestStream[];
  }>;
  acceptedMigrationHistory?: ManifestStream[];
}

const DEFAULT_ROLLOUT_POLICY: MigrationReleaseRolloutPolicy = {
  databaseExecution: 'setup_then_control',
  workerActivation: 'after_required_databases',
  adminMutationMode: 'read_only',
};

function isValidStreamId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_STREAM_ID_BYTES) return false;
  const segments = value.split('/');
  return (
    segments.length <= 4 && segments.every((segment) => STREAM_ID_SEGMENT_PATTERN.test(segment))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeObjectKey(value: string): void {
  const hasControlCharacter = Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    hasControlCharacter
  ) {
    throw new Error('migration_artifact_object_key_invalid');
  }
}

function parseMigrationIdentity(value: unknown): ManifestFile {
  if (!isRecord(value)) throw new Error('migration_artifact_manifest_invalid');
  if (
    typeof value.path !== 'string' ||
    !MIGRATION_PATH_PATTERN.test(value.path) ||
    value.path.includes('..') ||
    value.path.includes('//') ||
    typeof value.checksum !== 'string' ||
    !SHA256_PATTERN.test(value.checksum)
  ) {
    throw new Error('migration_artifact_manifest_invalid');
  }
  return { path: value.path, checksum: value.checksum };
}

function parseManifestFile(value: unknown): ManifestFile {
  const file = parseMigrationIdentity(value);
  if (!isRecord(value) || value.supersedes === undefined) return file;
  if (!Array.isArray(value.supersedes) || value.supersedes.length > MAX_FILES_PER_STREAM) {
    throw new Error('migration_artifact_manifest_limit_exceeded');
  }
  const supersedes = value.supersedes.map(parseMigrationIdentity);
  if (
    new Set(supersedes.map((candidate) => candidate.path)).size !== supersedes.length ||
    supersedes.some((candidate) => candidate.path === file.path)
  ) {
    throw new Error('migration_artifact_manifest_duplicate_file');
  }
  return { ...file, supersedes };
}

function parseManifestStream(value: unknown): ManifestStream {
  if (!isRecord(value) || typeof value.id !== 'string' || !isValidStreamId(value.id)) {
    throw new Error('migration_artifact_manifest_invalid');
  }
  if (
    !['sqlite', 'postgres', 'mysql'].includes(String(value.dialect)) ||
    !Array.isArray(value.files)
  ) {
    throw new Error('migration_artifact_manifest_invalid');
  }
  if (value.files.length > MAX_FILES_PER_STREAM) {
    throw new Error('migration_artifact_manifest_limit_exceeded');
  }
  const files = value.files.map(parseManifestFile);
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('migration_artifact_manifest_duplicate_file');
  }
  return {
    id: value.id,
    dialect: value.dialect as ManifestStream['dialect'],
    files,
  };
}

function parseManifestStreams(value: unknown): ManifestStream[] {
  if (!Array.isArray(value)) throw new Error('migration_artifact_manifest_invalid');
  if (value.length > MAX_STREAMS) {
    throw new Error('migration_artifact_manifest_limit_exceeded');
  }
  const streams = value.map(parseManifestStream);
  if (new Set(streams.map((stream) => stream.id)).size !== streams.length) {
    throw new Error('migration_artifact_manifest_duplicate_stream');
  }
  return streams;
}

function parseManifest(bytes: Uint8Array): MigrationManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new Error('migration_artifact_manifest_invalid');
  }
  if (
    !isRecord(value) ||
    value.formatVersion !== 1 ||
    typeof value.productVersion !== 'string' ||
    !RELEASE_ID_PATTERN.test(value.productVersion) ||
    !Array.isArray(value.streams)
  ) {
    throw new Error('migration_artifact_manifest_invalid');
  }
  const streams = parseManifestStreams(value.streams);
  let rollout = DEFAULT_ROLLOUT_POLICY;
  let upgradePaths: MigrationManifest['upgradePaths'];
  if (value.upgradePaths !== undefined) {
    if (!Array.isArray(value.upgradePaths)) {
      throw new Error('migration_artifact_manifest_invalid');
    }
    upgradePaths = value.upgradePaths.map((path) => {
      if (
        !isRecord(path) ||
        typeof path.fromProductVersion !== 'string' ||
        !PRODUCT_VERSION_PATTERN.test(path.fromProductVersion) ||
        !['delta', 'bridge'].includes(String(path.kind))
      ) {
        throw new Error('migration_artifact_manifest_invalid');
      }
      return {
        fromProductVersion: path.fromProductVersion,
        kind: path.kind as 'delta' | 'bridge',
        streams: parseManifestStreams(path.streams),
      };
    });
    if (new Set(upgradePaths.map((path) => path.fromProductVersion)).size !== upgradePaths.length) {
      throw new Error('migration_artifact_manifest_duplicate_upgrade_path');
    }
  }
  let acceptedMigrationHistory: ManifestStream[] | undefined;
  if (value.acceptedMigrationHistory !== undefined) {
    if (!Array.isArray(value.acceptedMigrationHistory)) {
      throw new Error('migration_artifact_manifest_invalid');
    }
    acceptedMigrationHistory = parseManifestStreams(value.acceptedMigrationHistory);
  }
  if (value.rollout !== undefined) {
    const rolloutRecord = isRecord(value.rollout) ? value.rollout : undefined;
    const rolloutKeys = rolloutRecord ? Object.keys(rolloutRecord) : [];
    const databaseOnly = rolloutRecord?.databaseOnly;
    const compatibleWorkerVersions = isRecord(databaseOnly)
      ? databaseOnly.compatibleWorkerVersions
      : undefined;
    if (
      !isRecord(value.rollout) ||
      (rolloutKeys.length !== 3 && rolloutKeys.length !== 4) ||
      rolloutKeys.some(
        (key) =>
          !['databaseExecution', 'workerActivation', 'adminMutationMode', 'databaseOnly'].includes(
            key
          )
      ) ||
      value.rollout.databaseExecution !== 'setup_then_control' ||
      value.rollout.workerActivation !== 'after_required_databases' ||
      !['available', 'read_only'].includes(String(value.rollout.adminMutationMode)) ||
      (databaseOnly !== undefined &&
        (!isRecord(databaseOnly) ||
          Object.keys(databaseOnly).length !== 1 ||
          !Array.isArray(compatibleWorkerVersions) ||
          compatibleWorkerVersions.length < 1 ||
          compatibleWorkerVersions.length > 100 ||
          compatibleWorkerVersions.some(
            (version) => typeof version !== 'string' || !PRODUCT_VERSION_PATTERN.test(version)
          ) ||
          new Set(compatibleWorkerVersions).size !== compatibleWorkerVersions.length))
    ) {
      throw new Error('migration_artifact_manifest_invalid');
    }
    rollout = value.rollout as unknown as MigrationReleaseRolloutPolicy;
  }
  return {
    formatVersion: 1,
    productVersion: value.productVersion,
    rollout,
    streams,
    ...(upgradePaths ? { upgradePaths } : {}),
    ...(acceptedMigrationHistory ? { acceptedMigrationHistory } : {}),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readObject(
  store: ReleaseArtifactStore,
  key: string,
  maxBytes: number,
  missingCode: string
): Promise<Uint8Array> {
  const object = await store.get(key);
  if (!object) throw new Error(missingCode);
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > maxBytes) {
    throw new Error('migration_artifact_object_too_large');
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size || bytes.byteLength > maxBytes) {
    throw new Error('migration_artifact_object_size_mismatch');
  }
  return bytes;
}

export class R2ReleaseArtifactStore implements ReleaseArtifactStore {
  constructor(private readonly bucket: Pick<R2Bucket, 'get'>) {}

  async get(key: string): Promise<ReleaseArtifactObject | null> {
    const object = await this.bucket.get(key);
    if (!object || !('body' in object)) return null;
    return object;
  }
}

export class MigrationReleaseArtifactReader {
  constructor(
    private readonly store: ReleaseArtifactStore,
    private readonly limits: MigrationArtifactReaderLimits = {}
  ) {}

  async load(pin: MigrationReleasePin): Promise<LoadedMigrationRelease> {
    if (!isValidStreamId(pin.streamId)) throw new Error('migration_release_stream_invalid');
    if (!RELEASE_ID_PATTERN.test(pin.releaseId)) throw new Error('migration_release_id_invalid');
    if (!SHA256_PATTERN.test(pin.manifestDigest)) {
      throw new Error('migration_release_manifest_digest_invalid');
    }
    if (
      pin.sourceProductVersion !== undefined &&
      !PRODUCT_VERSION_PATTERN.test(pin.sourceProductVersion)
    ) {
      throw new Error('migration_release_source_version_invalid');
    }
    assertSafeObjectKey(pin.manifestObjectKey);
    if (pin.manifestObjectKey !== `releases/${pin.releaseId}/${pin.manifestDigest}/manifest.json`) {
      throw new Error('migration_release_manifest_object_key_mismatch');
    }

    const manifestBytes = await readObject(
      this.store,
      pin.manifestObjectKey,
      this.limits.maxManifestBytes ?? MAX_MANIFEST_BYTES,
      'migration_release_manifest_missing'
    );
    if ((await sha256(manifestBytes)) !== pin.manifestDigest) {
      throw new Error('migration_release_manifest_digest_mismatch');
    }
    const manifest = parseManifest(manifestBytes);
    const expectedDraftReleaseId = `${manifest.productVersion}-draft.${pin.manifestDigest.slice(0, 12)}`;
    if (manifest.productVersion !== pin.releaseId && expectedDraftReleaseId !== pin.releaseId) {
      throw new Error('migration_release_id_mismatch');
    }
    const selectedStreams = pin.sourceProductVersion
      ? manifest.upgradePaths?.find((path) => path.fromProductVersion === pin.sourceProductVersion)
          ?.streams
      : manifest.streams;
    if (!selectedStreams) throw new Error('migration_release_upgrade_path_missing');
    const stream = selectedStreams.find((candidate) => candidate.id === pin.streamId);
    if (!stream) throw new Error('migration_release_stream_missing');
    if (stream.dialect !== 'sqlite') {
      throw new Error('migration_release_stream_dialect_unsupported');
    }
    const base = pin.manifestObjectKey.slice(0, pin.manifestObjectKey.lastIndexOf('/') + 1);
    const files: MigrationArtifactFile[] = [];
    let releaseSqlBytes = 0;
    for (const file of stream.files) {
      const objectKey = `${base}streams/${stream.id}/${file.path}`;
      assertSafeObjectKey(objectKey);
      const sqlBytes = await readObject(
        this.store,
        objectKey,
        this.limits.maxSqlObjectBytes ?? MAX_SQL_OBJECT_BYTES,
        'migration_release_sql_missing'
      );
      releaseSqlBytes += sqlBytes.byteLength;
      if (releaseSqlBytes > (this.limits.maxReleaseSqlBytes ?? MAX_RELEASE_SQL_BYTES)) {
        throw new Error('migration_release_bundle_too_large');
      }
      if ((await sha256(sqlBytes)) !== file.checksum) {
        throw new Error('migration_release_sql_checksum_mismatch');
      }
      let sql: string;
      try {
        sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(sqlBytes);
      } catch {
        throw new Error('migration_release_sql_invalid_utf8');
      }
      files.push({ ...file, sql });
    }
    const knownHistoryCandidates = manifest.acceptedMigrationHistory?.find(
      (candidate) => candidate.id === pin.streamId
    )?.files ?? [
      ...(manifest.streams.find((candidate) => candidate.id === pin.streamId)?.files ?? []),
      ...(manifest.upgradePaths ?? []).flatMap(
        (path) => path.streams.find((candidate) => candidate.id === pin.streamId)?.files ?? []
      ),
    ];
    const knownHistoryByPath = new Map<string, ManifestFile>();
    for (const file of knownHistoryCandidates) {
      const existing = knownHistoryByPath.get(file.path);
      if (existing && existing.checksum !== file.checksum) {
        throw new Error('migration_artifact_manifest_history_conflict');
      }
      knownHistoryByPath.set(file.path, file);
    }
    return {
      pin: { ...pin },
      productVersion: manifest.productVersion,
      rollout: manifest.rollout,
      files,
      knownHistory: [...knownHistoryByPath.values()],
    };
  }
}

export const MIGRATION_ARTIFACT_LIMITS = {
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxSqlObjectBytes: MAX_SQL_OBJECT_BYTES,
  maxReleaseSqlBytes: MAX_RELEASE_SQL_BYTES,
  maxStreams: MAX_STREAMS,
  maxFilesPerStream: MAX_FILES_PER_STREAM,
} as const;
