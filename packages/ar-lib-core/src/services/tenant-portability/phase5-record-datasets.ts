import type { TenantPortableDataset } from './module-contract.js';
import { classifyPublicAssetKey } from './public-asset-contract.js';
import type {
  PortableSqliteRow,
  SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector.js';
import type { CaptureSchema } from './sqlite-snapshot.js';

export const PUBLIC_ASSETS_DATASET: TenantPortableDataset = {
  id: 'flows-ui.public_assets',
  module: 'flows-ui',
  kind: 'settings',
  store: 'object',
  schemaVersion: 1,
  disposition: 'include',
};

export const USER_AVATARS_DATASET: TenantPortableDataset = {
  id: 'users.public_avatars',
  module: 'users',
  kind: 'users',
  store: 'object',
  schemaVersion: 1,
  disposition: 'include',
};

export const PLUGIN_CONFIGURATION_DATASET: TenantPortableDataset = {
  id: 'integrations.plugin_runner_configuration',
  module: 'integrations',
  kind: 'settings',
  store: 'object',
  schemaVersion: 1,
  disposition: 'include',
};

export const LOGICAL_PLACEMENT_DATASET: TenantPortableDataset = {
  id: 'placement-rebuild.logical_target_plan',
  module: 'placement-rebuild',
  kind: 'settings',
  store: 'object',
  schemaVersion: 1,
  disposition: 'include',
};

const schemas: Record<string, CaptureSchema> = {
  [PUBLIC_ASSETS_DATASET.id]: {
    table: 'tenant_public_asset_backup',
    tenantColumn: 'tenant_id',
    columns: ['tenant_id', 'asset_key', 'content_type', 'sha256', 'bytes_base64'],
    primaryKey: ['tenant_id', 'asset_key'],
    uniqueKeys: [],
  },
  [USER_AVATARS_DATASET.id]: {
    table: 'tenant_user_avatar_backup',
    tenantColumn: 'tenant_id',
    columns: ['tenant_id', 'asset_key', 'content_type', 'sha256', 'bytes_base64'],
    primaryKey: ['tenant_id', 'asset_key'],
    uniqueKeys: [],
  },
  [PLUGIN_CONFIGURATION_DATASET.id]: {
    table: 'tenant_plugin_configuration_backup',
    tenantColumn: 'tenant_id',
    columns: [
      'tenant_id',
      'installation_id',
      'plugin_id',
      'version_digest',
      'contract_version',
      'config_json',
    ],
    primaryKey: ['tenant_id', 'installation_id'],
    uniqueKeys: [],
  },
  [LOGICAL_PLACEMENT_DATASET.id]: {
    table: 'tenant_logical_target_plan_backup',
    tenantColumn: 'tenant_id',
    columns: ['tenant_id', 'plan_json'],
    primaryKey: ['tenant_id'],
    uniqueKeys: [],
  },
};

export interface PortablePublicAsset {
  tenantId: string;
  key: string;
  contentType: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface PortablePluginConfiguration {
  tenantId: string;
  installationId: string;
  pluginId: string;
  versionDigest: string;
  contractVersion: number;
  config: unknown;
}

export interface PortableLogicalTargetPlan {
  version: 1;
  databaseRoles: readonly string[];
  rebuild: readonly string[];
  externalPrerequisiteIds: readonly string[];
}

function invalid(): never {
  throw new Error('backup_phase5_record_dataset_invalid');
}

function text(row: PortableSqliteRow, key: string, maxBytes: number): string {
  const value = row[key];
  if (
    !value ||
    value[0] !== 'text' ||
    value[1] === null ||
    !value[1] ||
    new TextEncoder().encode(value[1]).length > maxBytes
  )
    invalid();
  return value[1];
}

function integer(row: PortableSqliteRow, key: string): number {
  const value = row[key];
  if (!value || value[0] !== 'integer' || value[1] === null || !/^[1-9][0-9]{0,8}$/.test(value[1]))
    invalid();
  return Number(value[1]);
}

function parseRow(rowJson: string, schema: CaptureSchema): PortableSqliteRow {
  let value: unknown;
  try {
    value = JSON.parse(rowJson) as unknown;
  } catch {
    return invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (Object.keys(value).sort().join(',') !== [...schema.columns].sort().join(',')) invalid();
  return value as PortableSqliteRow;
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return invalid();
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(result);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function detectedContentType(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39))
    return 'image/gif';
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  return null;
}

function encodedRow(row: PortableSqliteRow): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(row)}\n`);
}

async function encodePortableAsset(
  asset: PortablePublicAsset,
  category: 'settings' | 'users'
): Promise<Uint8Array> {
  const digest = await sha256(asset.bytes);
  const classification = classifyPublicAssetKey(asset.key, asset.tenantId);
  if (
    classification.kind !== 'asset' ||
    classification.category !== category ||
    asset.sha256 !== digest ||
    detectedContentType(asset.bytes) !== asset.contentType
  )
    invalid();
  return encodedRow({
    tenant_id: ['text', asset.tenantId],
    asset_key: ['text', asset.key],
    content_type: ['text', asset.contentType],
    sha256: ['text', digest],
    bytes_base64: ['text', encodeBase64(asset.bytes)],
  });
}

export function encodePortablePublicAsset(asset: PortablePublicAsset): Promise<Uint8Array> {
  return encodePortableAsset(asset, 'settings');
}

export function encodePortableUserAvatar(asset: PortablePublicAsset): Promise<Uint8Array> {
  return encodePortableAsset(asset, 'users');
}

async function decodePortableAsset(
  rowJson: string,
  tenantId: string,
  datasetId: string,
  category: 'settings' | 'users'
): Promise<PortablePublicAsset> {
  const row = parseRow(rowJson, schemas[datasetId]);
  if (text(row, 'tenant_id', 256) !== tenantId) invalid();
  const key = text(row, 'asset_key', 512);
  const classification = classifyPublicAssetKey(key, tenantId);
  if (classification.kind !== 'asset' || classification.category !== category) invalid();
  const bytes = decodeBase64(text(row, 'bytes_base64', 7 * 1024 * 1024));
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) invalid();
  const contentType = text(row, 'content_type', 128);
  const digest = text(row, 'sha256', 64);
  if (!/^[a-f0-9]{64}$/.test(digest) || (await sha256(bytes)) !== digest) invalid();
  if (detectedContentType(bytes) !== contentType) invalid();
  return { tenantId, key, contentType, sha256: digest, bytes };
}

export function decodePortablePublicAsset(
  rowJson: string,
  tenantId: string
): Promise<PortablePublicAsset> {
  return decodePortableAsset(rowJson, tenantId, PUBLIC_ASSETS_DATASET.id, 'settings');
}

export function decodePortableUserAvatar(
  rowJson: string,
  tenantId: string
): Promise<PortablePublicAsset> {
  return decodePortableAsset(rowJson, tenantId, USER_AVATARS_DATASET.id, 'users');
}

export function decodePortablePluginConfiguration(
  rowJson: string,
  tenantId: string
): PortablePluginConfiguration {
  const row = parseRow(rowJson, schemas[PLUGIN_CONFIGURATION_DATASET.id]);
  if (text(row, 'tenant_id', 256) !== tenantId) invalid();
  const versionDigest = text(row, 'version_digest', 64);
  if (!/^[a-f0-9]{64}$/.test(versionDigest)) invalid();
  let config: unknown;
  try {
    config = JSON.parse(text(row, 'config_json', 4 * 1024 * 1024));
  } catch {
    return invalid();
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) invalid();
  return {
    tenantId,
    installationId: text(row, 'installation_id', 256),
    pluginId: text(row, 'plugin_id', 256),
    versionDigest,
    contractVersion: integer(row, 'contract_version'),
    config,
  };
}

export function encodePortablePluginConfiguration(
  configuration: PortablePluginConfiguration
): Uint8Array {
  const configJson = JSON.stringify(configuration.config);
  if (
    !/^[a-f0-9]{64}$/.test(configuration.versionDigest) ||
    !Number.isSafeInteger(configuration.contractVersion) ||
    configuration.contractVersion < 1 ||
    !configJson ||
    new TextEncoder().encode(configJson).length > 4 * 1024 * 1024
  )
    invalid();
  const encoded = encodedRow({
    tenant_id: ['text', configuration.tenantId],
    installation_id: ['text', configuration.installationId],
    plugin_id: ['text', configuration.pluginId],
    version_digest: ['text', configuration.versionDigest],
    contract_version: ['integer', String(configuration.contractVersion)],
    config_json: ['text', configJson],
  });
  decodePortablePluginConfiguration(
    new TextDecoder().decode(encoded).trimEnd(),
    configuration.tenantId
  );
  return encoded;
}

function stringArray(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : invalid();
  if (
    items.length > 256 ||
    items.some((item) => typeof item !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item)) ||
    new Set(items).size !== items.length
  )
    invalid();
  return items.map((item) => String(item)).sort();
}

function rejectPhysicalIdentifiers(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectPhysicalIdentifiers);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (
      ['databaseid', 'bucketname', 'accountid', 'namespaceid', 'resourceid', 'bindingid'].includes(
        normalized
      )
    )
      invalid();
    rejectPhysicalIdentifiers(item);
  }
}

export function decodePortableLogicalTargetPlan(
  rowJson: string,
  tenantId: string
): PortableLogicalTargetPlan {
  const row = parseRow(rowJson, schemas[LOGICAL_PLACEMENT_DATASET.id]);
  if (text(row, 'tenant_id', 256) !== tenantId) invalid();
  let value: unknown;
  try {
    value = JSON.parse(text(row, 'plan_json', 256 * 1024));
  } catch {
    return invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const plan = value as Record<string, unknown>;
  if (
    Object.keys(plan).sort().join(',') !==
      'databaseRoles,externalPrerequisiteIds,rebuild,version' ||
    plan.version !== 1
  )
    invalid();
  rejectPhysicalIdentifiers(plan);
  return {
    version: 1,
    databaseRoles: stringArray(plan.databaseRoles),
    rebuild: stringArray(plan.rebuild),
    externalPrerequisiteIds: stringArray(plan.externalPrerequisiteIds),
  };
}

export function encodePortableLogicalTargetPlan(
  tenantId: string,
  plan: PortableLogicalTargetPlan
): Uint8Array {
  const encoded = encodedRow({
    tenant_id: ['text', tenantId],
    plan_json: ['text', JSON.stringify(plan)],
  });
  decodePortableLogicalTargetPlan(new TextDecoder().decode(encoded).trimEnd(), tenantId);
  return encoded;
}

export function createPhase5RecordDatasetPolicies(input: {
  assertPluginSupported(configuration: PortablePluginConfiguration): Promise<void>;
}): SqliteDatasetInspectionPolicy[] {
  return [
    {
      dataset: structuredClone(PUBLIC_ASSETS_DATASET),
      schema: structuredClone(schemas[PUBLIC_ASSETS_DATASET.id]),
      async inspectRow(row) {
        await decodePortablePublicAsset(JSON.stringify(row), text(row, 'tenant_id', 256));
        return [];
      },
    },
    {
      dataset: structuredClone(PLUGIN_CONFIGURATION_DATASET),
      schema: structuredClone(schemas[PLUGIN_CONFIGURATION_DATASET.id]),
      async inspectRow(row) {
        const configuration = decodePortablePluginConfiguration(
          JSON.stringify(row),
          text(row, 'tenant_id', 256)
        );
        await input.assertPluginSupported(configuration);
        return [];
      },
    },
    {
      dataset: structuredClone(LOGICAL_PLACEMENT_DATASET),
      schema: structuredClone(schemas[LOGICAL_PLACEMENT_DATASET.id]),
      async inspectRow(row) {
        decodePortableLogicalTargetPlan(JSON.stringify(row), text(row, 'tenant_id', 256));
        return [];
      },
    },
  ];
}

/** Phase 8 user-owned PUBLIC_ASSETS records; kept separate from settings image selection. */
export function createUserAvatarDatasetPolicy(): SqliteDatasetInspectionPolicy {
  return {
    dataset: structuredClone(USER_AVATARS_DATASET),
    schema: structuredClone(schemas[USER_AVATARS_DATASET.id]),
    async inspectRow(row) {
      await decodePortableUserAvatar(JSON.stringify(row), text(row, 'tenant_id', 256));
      return [];
    },
  };
}
