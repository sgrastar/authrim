import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { AuthrimConfig } from './config.js';
import type { AuthrimLock } from './lock.js';
import { getTenantDatabaseRoleFromBinding, isTenantDatabaseBinding } from './tenant-database.js';
import { renderPortableMigrationSql, type MigrationSqlDialect } from './sql-portability.js';

export const RELEASE_MIGRATION_MANIFEST_FORMAT_VERSION = 1 as const;
export const DRAFT_RELEASE_MANIFEST_FILENAME = 'release-manifest.draft.json';
const PRODUCT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const ProductVersionSchema = z.string().regex(PRODUCT_VERSION_PATTERN);
const MigrationPathSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._/-]*\.sql$/u)
  .refine((path) => !path.includes('..') && !path.includes('//'), {
    message: 'Migration paths must remain inside their logical stream directory',
  });

export const ReleaseMigrationSupersededFileSchema = z.object({
  path: MigrationPathSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const ReleaseMigrationFileSchema = z.object({
  path: MigrationPathSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  supersedes: z
    .array(ReleaseMigrationSupersededFileSchema)
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length, {
      message: 'Superseded migration paths must be unique',
    })
    .optional(),
});

export const ReleaseMigrationStreamSchema = z
  .object({
    id: z.string().min(1),
    dialect: z.enum(['sqlite', 'postgres', 'mysql']),
    logicalRoles: z.array(z.string().min(1)).min(1),
    files: z.array(ReleaseMigrationFileSchema),
  })
  .refine((stream) => new Set(stream.files.map((file) => file.path)).size === stream.files.length, {
    message: 'Migration paths must be unique within a stream',
  });

export const ReleaseMigrationManifestSchema = z
  .object({
    formatVersion: z.literal(RELEASE_MIGRATION_MANIFEST_FORMAT_VERSION),
    productVersion: ProductVersionSchema,
    minimumProductVersion: ProductVersionSchema.optional(),
    streams: z.array(ReleaseMigrationStreamSchema),
  })
  .refine(
    (manifest) =>
      new Set(manifest.streams.map((stream) => stream.id)).size === manifest.streams.length,
    { message: 'Release migration stream IDs must be unique' }
  );

export type ReleaseMigrationFile = z.infer<typeof ReleaseMigrationFileSchema>;
export type ReleaseMigrationStream = z.infer<typeof ReleaseMigrationStreamSchema>;
export type ReleaseMigrationManifest = z.infer<typeof ReleaseMigrationManifestSchema>;

export interface MigrationStreamDefinition {
  id: string;
  dialect: MigrationSqlDialect;
  directory: string;
  logicalRoles: string[];
  excludeTopLevelDirectories?: ReadonlySet<string>;
  includePath?: (path: string) => boolean;
}

const CORE_EXCLUDED_DIRECTORIES = new Set([
  'admin',
  'archive',
  'control',
  'external',
  'lookup',
  'pii',
  'plugin-runner',
  'releases',
]);
const EXTERNAL_POSTGRES_PII_MIGRATION_PATTERN =
  /_(?:durable_pii|totp_credentials|linked_identity|external_postgres_pii)(?:_|\.)/u;

function isExternalPostgresPiiMigration(path: string): boolean {
  return path.startsWith('pii/') || EXTERNAL_POSTGRES_PII_MIGRATION_PATTERN.test(path);
}

export const RELEASE_MIGRATION_STREAM_DEFINITIONS: readonly MigrationStreamDefinition[] = [
  {
    id: 'd1-core',
    dialect: 'sqlite',
    directory: '.',
    logicalRoles: ['core', 'tenant_core'],
    excludeTopLevelDirectories: CORE_EXCLUDED_DIRECTORIES,
  },
  {
    id: 'd1-pii',
    dialect: 'sqlite',
    directory: 'pii',
    logicalRoles: ['pii', 'tenant_pii'],
  },
  {
    id: 'd1-admin',
    dialect: 'sqlite',
    directory: 'admin',
    logicalRoles: ['admin', 'control'],
  },
  {
    id: 'd1-control',
    dialect: 'sqlite',
    directory: 'control',
    logicalRoles: ['control'],
  },
  {
    id: 'd1-lookup',
    dialect: 'sqlite',
    directory: 'lookup',
    logicalRoles: ['lookup'],
  },
  {
    id: 'd1-plugin-runner',
    dialect: 'sqlite',
    directory: 'plugin-runner',
    logicalRoles: ['plugin_runner'],
  },
  {
    id: 'external-postgres-core',
    dialect: 'postgres',
    directory: 'external/postgres',
    logicalRoles: ['core', 'custom', 'policy'],
    includePath: (path) => !isExternalPostgresPiiMigration(path),
  },
  {
    id: 'external-postgres-pii',
    dialect: 'postgres',
    directory: 'external/postgres',
    logicalRoles: ['pii'],
    includePath: isExternalPostgresPiiMigration,
  },
] as const;

function listSqlFiles(
  root: string,
  options: { excludeTopLevelDirectories?: ReadonlySet<string> } = {}
): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];

  function walk(relativeDirectory: string): void {
    const absoluteDirectory = relativeDirectory ? join(root, relativeDirectory) : root;
    for (const entry of readdirSync(absoluteDirectory).sort()) {
      if (entry.startsWith('.')) continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const absolutePath = join(root, relativePath);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        if (!relativeDirectory && options.excludeTopLevelDirectories?.has(entry)) continue;
        walk(relativePath);
      } else if (stat.isFile() && entry.endsWith('.sql')) {
        files.push(relativePath);
      }
    }
  }

  walk('');
  return files.sort();
}

export function calculateReleaseMigrationChecksum(
  filePath: string,
  dialect: MigrationSqlDialect
): string {
  const rendered = renderPortableMigrationSql(readFileSync(filePath, 'utf-8'), dialect);
  return createHash('sha256').update(rendered).digest('hex');
}

function previousFileByStreamAndPath(
  previousManifest: ReleaseMigrationManifest | undefined
): Map<string, ReleaseMigrationFile> {
  const previous = new Map<string, ReleaseMigrationFile>();
  for (const stream of previousManifest?.streams ?? []) {
    for (const file of stream.files) previous.set(`${stream.id}:${file.path}`, file);
  }
  return previous;
}

export function generateReleaseMigrationManifest(input: {
  migrationsRoot: string;
  productVersion: string;
  minimumProductVersion?: string;
  previousManifest?: ReleaseMigrationManifest;
}): ReleaseMigrationManifest {
  const previousFiles = previousFileByStreamAndPath(input.previousManifest);
  const minimumProductVersion =
    input.minimumProductVersion ??
    (input.previousManifest?.productVersion === input.productVersion
      ? input.previousManifest.minimumProductVersion
      : undefined);
  const streams = RELEASE_MIGRATION_STREAM_DEFINITIONS.map((definition) => {
    const streamRoot = join(input.migrationsRoot, definition.directory);
    const paths = listSqlFiles(streamRoot, {
      excludeTopLevelDirectories: definition.excludeTopLevelDirectories,
    }).filter((path) => definition.includePath?.(path) ?? true);
    return {
      id: definition.id,
      dialect: definition.dialect,
      logicalRoles: [...definition.logicalRoles],
      files: paths.map((path) => {
        const checksum = calculateReleaseMigrationChecksum(
          join(streamRoot, path),
          definition.dialect
        );
        const previous = previousFiles.get(`${definition.id}:${path}`);
        return {
          path,
          checksum,
          ...(previous?.checksum === checksum && previous.supersedes
            ? { supersedes: previous.supersedes }
            : {}),
        };
      }),
    };
  });

  return ReleaseMigrationManifestSchema.parse({
    formatVersion: RELEASE_MIGRATION_MANIFEST_FORMAT_VERSION,
    productVersion: input.productVersion,
    ...(minimumProductVersion ? { minimumProductVersion } : {}),
    streams,
  });
}

export function serializeReleaseMigrationManifest(manifest: ReleaseMigrationManifest): string {
  return `${JSON.stringify(ReleaseMigrationManifestSchema.parse(manifest), null, 2)}\n`;
}

export function calculateReleaseManifestChecksum(manifest: ReleaseMigrationManifest): string {
  return createHash('sha256').update(serializeReleaseMigrationManifest(manifest)).digest('hex');
}

export function readReleaseMigrationManifest(path: string): ReleaseMigrationManifest {
  return ReleaseMigrationManifestSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

export function writeReleaseMigrationManifest(
  path: string,
  manifest: ReleaseMigrationManifest
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeReleaseMigrationManifest(manifest), 'utf-8');
}

export function syncDraftReleaseMigrationManifest(input: {
  migrationsRoot: string;
  productVersion: string;
}): { path: string; manifest: ReleaseMigrationManifest } {
  const previousManifest = findLatestReleaseMigrationManifest(input.migrationsRoot)?.manifest;
  assertProductVersionNotBehindPublished(input.productVersion, previousManifest?.productVersion);
  const manifest = generateReleaseMigrationManifest({
    migrationsRoot: input.migrationsRoot,
    productVersion: input.productVersion,
    previousManifest,
  });
  const publishedSameVersion = join(
    input.migrationsRoot,
    'releases',
    `${input.productVersion}.json`
  );
  if (existsSync(publishedSameVersion)) {
    const published = readReleaseMigrationManifest(publishedSameVersion);
    if (
      serializeReleaseMigrationManifest(published) !== serializeReleaseMigrationManifest(manifest)
    ) {
      throw new Error(
        `product_version_already_published:${input.productVersion}:bump the root package version before adding migrations`
      );
    }
  }
  const path = join(input.migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME);
  writeReleaseMigrationManifest(path, manifest);
  return { path, manifest };
}

export function assertProductVersionNotBehindPublished(
  productVersion: string,
  latestPublishedVersion: string | undefined
): void {
  if (
    latestPublishedVersion &&
    compareProductVersions(productVersion, latestPublishedVersion) < 0
  ) {
    throw new Error(
      `product_version_behind_latest_release:${productVersion}:${latestPublishedVersion}`
    );
  }
}

export function assertProductVersionOpenForNewMigrations(
  migrationsRoot: string,
  productVersion: string
): void {
  if (existsSync(join(migrationsRoot, 'releases', `${productVersion}.json`))) {
    throw new Error(
      `product_version_already_published:${productVersion}:bump the root package version before adding migrations`
    );
  }
}

export function findLatestReleaseMigrationManifest(
  migrationsRoot: string
): { path: string; manifest: ReleaseMigrationManifest } | null {
  return listReleaseMigrationManifests(migrationsRoot).at(-1) ?? null;
}

export function listReleaseMigrationManifests(
  migrationsRoot: string
): Array<{ path: string; manifest: ReleaseMigrationManifest }> {
  const releasesDirectory = join(migrationsRoot, 'releases');
  if (!existsSync(releasesDirectory)) return [];
  return readdirSync(releasesDirectory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const path = join(releasesDirectory, entry);
      const manifest = readReleaseMigrationManifest(path);
      if (entry !== `${manifest.productVersion}.json`) {
        throw new Error(
          `Release manifest filename/version mismatch: ${entry} != ${manifest.productVersion}`
        );
      }
      return { path, manifest };
    })
    .sort((a, b) => compareProductVersions(a.manifest.productVersion, b.manifest.productVersion));
}

export function validateReleaseMigrationManifestFiles(
  migrationsRoot: string,
  manifest: ReleaseMigrationManifest
): void {
  for (const stream of manifest.streams) {
    const directory = streamDirectory(migrationsRoot, stream.id);
    if (!directory) throw new Error(`Unknown release migration stream: ${stream.id}`);
    for (const file of stream.files) {
      const path = join(directory, file.path);
      if (!existsSync(path)) {
        throw new Error(
          `Release migration is missing: ${manifest.productVersion}/${stream.id}/${file.path}`
        );
      }
      const checksum = calculateReleaseMigrationChecksum(path, stream.dialect);
      if (checksum !== file.checksum) {
        throw new Error(
          `Release migration checksum changed: ${manifest.productVersion}/${stream.id}/${file.path}`
        );
      }
    }
  }
}

export function validatePublishedReleaseMigrationManifests(migrationsRoot: string): void {
  for (const { manifest } of listReleaseMigrationManifests(migrationsRoot)) {
    try {
      validateReleaseMigrationManifestFiles(migrationsRoot, manifest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/^Release migration/u, 'Published migration'));
    }
  }
}

export function compareProductVersions(left: string, right: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    const withoutBuild = value.split('+', 1)[0];
    const [core, prerelease = ''] = withoutBuild.split('-', 2);
    return {
      core: core.split('.').map((part) => Number.parseInt(part, 10)),
      prerelease: prerelease ? prerelease.split('.') : [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease.length === 0 && b.prerelease.length > 0) return 1;
  if (a.prerelease.length > 0 && b.prerelease.length === 0) return -1;
  const identifiers = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Number.parseInt(leftIdentifier, 10) - Number.parseInt(rightIdentifier, 10);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

export function isProductVersion(value: string): boolean {
  return ProductVersionSchema.safeParse(value).success;
}

export function loadTargetReleaseMigrationManifest(input: {
  migrationsRoot: string;
  productVersion: string;
  allowDraft?: boolean;
}): { path: string; manifest: ReleaseMigrationManifest; draft: boolean } {
  const releasePath = join(input.migrationsRoot, 'releases', `${input.productVersion}.json`);
  if (existsSync(releasePath)) {
    const manifest = readReleaseMigrationManifest(releasePath);
    if (manifest.productVersion !== input.productVersion) {
      throw new Error(
        `release_migration_manifest_version_mismatch:${input.productVersion}:${manifest.productVersion}`
      );
    }
    const draftPath = join(input.migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME);
    if (existsSync(draftPath)) {
      const draft = readReleaseMigrationManifest(draftPath);
      if (
        draft.productVersion === input.productVersion &&
        serializeReleaseMigrationManifest(draft) !== serializeReleaseMigrationManifest(manifest)
      ) {
        throw new Error(`draft_manifest_diverges_from_published_version:${input.productVersion}`);
      }
    }
    validateReleaseMigrationManifestFiles(input.migrationsRoot, manifest);
    return { path: releasePath, manifest, draft: false };
  }
  const draftPath = join(input.migrationsRoot, DRAFT_RELEASE_MANIFEST_FILENAME);
  if (input.allowDraft && existsSync(draftPath)) {
    const manifest = readReleaseMigrationManifest(draftPath);
    if (manifest.productVersion === input.productVersion) {
      validateReleaseMigrationManifestFiles(input.migrationsRoot, manifest);
      return { path: draftPath, manifest, draft: true };
    }
  }
  throw new Error(`release_migration_manifest_not_found:${input.productVersion}`);
}

export function loadInstalledReleaseMigrationManifest(input: {
  migrationsRoot: string;
  productVersion: string;
  lock: AuthrimLock;
}): { path: string; manifest: ReleaseMigrationManifest; draft: boolean } {
  const result = loadTargetReleaseMigrationManifest({
    migrationsRoot: input.migrationsRoot,
    productVersion: input.productVersion,
    allowDraft: true,
  });
  if (!result.draft) return result;

  const checksum = calculateReleaseManifestChecksum(result.manifest);
  const installed = input.lock.releaseUpdate;
  if (
    installed?.phase !== 'verified' ||
    installed.targetVersion !== input.productVersion ||
    installed.manifestChecksum !== checksum ||
    input.lock.productVersion !== input.productVersion
  ) {
    throw new Error(`unverified_draft_release_manifest:${input.productVersion}`);
  }
  return result;
}

export type MigrationTargetDriver = 'd1' | 'postgres' | 'mysql';
export type MigrationTargetScope = 'deployment' | 'tenant' | 'external';

export interface ReleaseMigrationPhysicalTarget {
  id: string;
  streamId: string | null;
  driver: MigrationTargetDriver;
  scope: MigrationTargetScope;
  logicalRoles: string[];
  binding?: string;
  databaseId?: string;
  databaseName?: string;
  connectionRef?: string;
  shard?: string;
  automatic: boolean;
  blockedReason?: string;
}

function tenantShardFromBinding(binding: string): string | undefined {
  return binding.match(/_S([0-9]+)$/u)?.[1];
}

export function buildTenantD1ReleaseMigrationTarget(input: {
  binding: string;
  databaseId: string;
  databaseName: string;
  role: 'tenant_core' | 'tenant_pii';
}): ReleaseMigrationPhysicalTarget {
  const streamId = input.role === 'tenant_core' ? 'd1-core' : 'd1-pii';
  return {
    id: `d1:${input.databaseId}:${streamId}`,
    streamId,
    driver: 'd1',
    scope: 'tenant',
    logicalRoles: [input.role],
    binding: input.binding,
    databaseId: input.databaseId,
    databaseName: input.databaseName,
    shard: tenantShardFromBinding(input.binding),
    automatic: true,
  };
}

function pushUniqueTarget(
  targets: ReleaseMigrationPhysicalTarget[],
  target: ReleaseMigrationPhysicalTarget
): void {
  const existing = targets.find((candidate) => candidate.id === target.id);
  if (!existing) {
    targets.push(target);
    return;
  }
  existing.logicalRoles = [...new Set([...existing.logicalRoles, ...target.logicalRoles])].sort();
}

function resolveHyperdriveReference(
  config: AuthrimConfig,
  ref: string
): { connectionRef: string; binding: string; driver: 'postgres' | 'mysql' } | null {
  const direct = config.profiles.references.hyperdrive[ref];
  if (direct) return { connectionRef: ref, binding: direct.binding, driver: direct.driver };
  const byBinding = Object.entries(config.profiles.references.hyperdrive).find(
    ([, reference]) => reference.binding === ref
  );
  if (!byBinding) return null;
  return {
    connectionRef: byBinding[0],
    binding: byBinding[1].binding,
    driver: byBinding[1].driver,
  };
}

function addExternalTarget(
  targets: ReleaseMigrationPhysicalTarget[],
  config: AuthrimConfig,
  input: {
    driver: 'postgres' | 'mysql';
    ref?: string;
    logicalRole: string;
  }
): void {
  if (!input.ref) return;
  const reference = resolveHyperdriveReference(config, input.ref);
  const driver = reference?.driver ?? input.driver;
  const connectionRef = reference?.connectionRef ?? input.ref;
  const streamId =
    driver === 'postgres'
      ? input.logicalRole === 'pii'
        ? 'external-postgres-pii'
        : ['core', 'custom', 'policy'].includes(input.logicalRole)
          ? 'external-postgres-core'
          : null
      : null;
  const targetStreamKey = streamId ?? input.logicalRole;
  pushUniqueTarget(targets, {
    id: `external:${driver}:${connectionRef}:${targetStreamKey}`,
    streamId,
    driver,
    scope: 'external',
    logicalRoles: [input.logicalRole],
    connectionRef,
    binding: reference?.binding,
    automatic: false,
    blockedReason: streamId
      ? 'external_database_executor_not_configured'
      : `release_migration_stream_not_available:${driver}`,
  });
}

export function resolveReleaseMigrationTargets(input: {
  lock: AuthrimLock;
  config: AuthrimConfig;
}): ReleaseMigrationPhysicalTarget[] {
  const targets: ReleaseMigrationPhysicalTarget[] = [];
  const sharedBindings: Array<{ binding: string; streamId: string; logicalRole: string }> = [
    { binding: 'DB', streamId: 'd1-core', logicalRole: 'core' },
    { binding: 'DB_PII', streamId: 'd1-pii', logicalRole: 'pii' },
    { binding: 'DB_ADMIN', streamId: 'd1-admin', logicalRole: 'admin' },
  ];

  for (const definition of sharedBindings) {
    const resource = input.lock.d1[definition.binding];
    if (!resource) continue;
    pushUniqueTarget(targets, {
      id: `d1:${resource.id}:${definition.streamId}`,
      streamId: definition.streamId,
      driver: 'd1',
      scope: 'deployment',
      logicalRoles: [definition.logicalRole],
      binding: definition.binding,
      databaseId: resource.id,
      databaseName: resource.name,
      automatic: true,
    });
  }

  if (input.config.profiles.defaults.storage === 'builtin:storage:single-db') {
    const core = input.lock.d1.DB;
    if (core) {
      pushUniqueTarget(targets, {
        id: `d1:${core.id}:d1-pii`,
        streamId: 'd1-pii',
        driver: 'd1',
        scope: 'deployment',
        logicalRoles: ['pii'],
        binding: 'DB',
        databaseId: core.id,
        databaseName: core.name,
        automatic: true,
      });
    }
  }

  for (const [binding, resource] of Object.entries(input.lock.d1)) {
    if (!isTenantDatabaseBinding(binding)) continue;
    const role = getTenantDatabaseRoleFromBinding(binding);
    if (!role) {
      const unsupportedRole = binding.match(/_(AUDIT|CUSTOM)(?:_S[0-9]+)?$/u)?.[1]?.toLowerCase();
      pushUniqueTarget(targets, {
        id: `d1:${resource.id}:unsupported:${unsupportedRole ?? 'unknown'}`,
        streamId: null,
        driver: 'd1',
        scope: 'tenant',
        logicalRoles: [`tenant_${unsupportedRole ?? 'unknown'}`],
        binding,
        databaseId: resource.id,
        databaseName: resource.name,
        shard: tenantShardFromBinding(binding),
        automatic: false,
        blockedReason: `release_migration_stream_not_available:tenant_${unsupportedRole ?? 'unknown'}`,
      });
      continue;
    }
    pushUniqueTarget(
      targets,
      buildTenantD1ReleaseMigrationTarget({
        binding,
        databaseId: resource.id,
        databaseName: resource.name,
        role,
      })
    );
  }

  if (input.config.profiles.defaults.storage === 'builtin:storage:external-postgres') {
    addExternalTarget(targets, input.config, {
      driver: 'postgres',
      ref: 'core-primary',
      logicalRole: 'core',
    });
    addExternalTarget(targets, input.config, {
      driver: 'postgres',
      ref: 'pii-primary',
      logicalRole: 'pii',
    });
  }

  // Tenant overrides can select any setup-seeded runtime profile. Enumerating only the
  // environment default would let a tenant-specific external database escape the release plan.
  for (const profile of input.config.profiles.seed.storage) {
    for (const target of Object.values(profile.slices ?? {})) {
      if (!target || target.driver === 'd1') continue;
      addExternalTarget(targets, input.config, {
        driver: target.driver,
        ref: target.connectionRef ?? target.bindingRef,
        logicalRole: target.role ?? 'custom',
      });
    }
  }

  for (const profile of input.config.profiles.seed.audit) {
    for (const target of [profile.primary, profile.archive]) {
      if (!target || target.type === 'd1' || target.type === 'r2') continue;
      addExternalTarget(targets, input.config, {
        driver: target.type,
        ref: target.connectionRef ?? target.bindingRef,
        logicalRole: 'audit',
      });
    }
  }

  return targets.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveRegisteredSchemaReferences(input: {
  lock: AuthrimLock;
  config: AuthrimConfig;
}): string[] {
  const releaseEvidence =
    input.lock.releaseUpdate && input.lock.releaseUpdate.phase !== 'planned'
      ? input.lock.releaseUpdate
      : undefined;
  if (!releaseEvidence) return [];
  const schemaVersion = releaseEvidence.targetVersion;

  const references = new Set<string>();
  for (const target of resolveReleaseMigrationTargets(input)) {
    // Tenant D1 bindings are selected through the signed tenant database runtime registry,
    // not through admin-created runtime profiles. Emitting every preallocated slot here would
    // make this Worker text variable grow linearly with the tenant pool and exceed Cloudflare's
    // per-variable size limit. Shared and setup-seeded external profile references remain listed.
    if (target.scope === 'tenant') continue;
    if (!target.streamId) continue;
    const state = input.lock.schemaTargets?.[target.id];
    if (
      !state ||
      state.productVersion !== schemaVersion ||
      state.manifestChecksum !== releaseEvidence.manifestChecksum ||
      state.streamId !== target.streamId ||
      !Array.isArray(state.files)
    ) {
      continue;
    }
    if (target.binding) references.add(`binding:${target.binding}:${target.streamId}`);
    if (target.connectionRef) {
      references.add(`connection:${target.connectionRef}:${target.streamId}`);
    }
  }
  return [...references].sort();
}

export function streamDirectory(migrationsRoot: string, streamId: string): string | null {
  const definition = RELEASE_MIGRATION_STREAM_DEFINITIONS.find((item) => item.id === streamId);
  return definition ? join(migrationsRoot, definition.directory) : null;
}

export function discoverReleaseMigrationStream(migrationsDir: string): {
  manifest: ReleaseMigrationManifest;
  stream: ReleaseMigrationStream;
  draft: boolean;
} | null {
  let candidate = resolve(migrationsDir);
  for (let depth = 0; depth < 4; depth += 1) {
    const draftPath = join(candidate, DRAFT_RELEASE_MANIFEST_FILENAME);
    const draftManifest = existsSync(draftPath)
      ? readReleaseMigrationManifest(draftPath)
      : undefined;
    const latestPublished = findLatestReleaseMigrationManifest(candidate)?.manifest;
    if (draftManifest || latestPublished) {
      if (
        draftManifest &&
        latestPublished &&
        compareProductVersions(draftManifest.productVersion, latestPublished.productVersion) < 0
      ) {
        throw new Error(
          `draft_manifest_older_than_published_version:${draftManifest.productVersion}:${latestPublished.productVersion}`
        );
      }
      const sameVersionReleasePath = draftManifest
        ? join(candidate, 'releases', `${draftManifest.productVersion}.json`)
        : undefined;
      const sameVersionPublished =
        sameVersionReleasePath && existsSync(sameVersionReleasePath)
          ? readReleaseMigrationManifest(sameVersionReleasePath)
          : undefined;
      if (
        draftManifest &&
        sameVersionPublished &&
        serializeReleaseMigrationManifest(sameVersionPublished) !==
          serializeReleaseMigrationManifest(draftManifest)
      ) {
        throw new Error(
          `draft_manifest_diverges_from_published_version:${draftManifest.productVersion}`
        );
      }
      const manifest = sameVersionPublished ?? draftManifest ?? latestPublished!;
      const definition = RELEASE_MIGRATION_STREAM_DEFINITIONS.find(
        (item) => resolve(candidate, item.directory) === resolve(migrationsDir)
      );
      const stream = definition
        ? manifest.streams.find((item) => item.id === definition.id)
        : undefined;
      if (stream) {
        return {
          manifest,
          stream,
          draft: !sameVersionPublished && Boolean(draftManifest),
        };
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return null;
}

export function relativeMigrationRoot(rootDir: string, path: string): string {
  return relative(rootDir, path).replaceAll('\\', '/');
}
