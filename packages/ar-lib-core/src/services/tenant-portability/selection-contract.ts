import type { TenantDatasetKind } from './dataset-registry.js';

/** Versioned request intent. Neither selection nor classification grants access to a row. */
export interface TenantBackupSelection {
  settings: boolean;
  users: boolean;
  admin: boolean;
  logs: {
    audit: boolean;
    other: boolean;
    sensitive: boolean;
    period: 7 | 30 | 90 | 'all';
  };
  artifacts: boolean;
}

export type TenantBackupCategory = 'settings' | 'users' | 'admin';

export class TenantBackupSelectionError extends Error {
  constructor() {
    // Do not echo request values: future callers may pass sensitive uploaded metadata.
    super('invalid_tenant_backup_selection');
    this.name = 'TenantBackupSelectionError';
  }
}

function objectWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new TenantBackupSelectionError();
  }
  return value as Record<string, unknown>;
}

/** Strict parsing avoids silently changing scope when a caller misspells an option. */
export function parseTenantBackupSelection(value: unknown): TenantBackupSelection {
  const root = objectWithKeys(value, ['settings', 'users', 'admin', 'logs', 'artifacts']);
  const logs = objectWithKeys(root.logs, ['audit', 'other', 'sensitive', 'period']);
  for (const candidate of [
    root.settings,
    root.users,
    root.admin,
    root.artifacts,
    logs.audit,
    logs.other,
    logs.sensitive,
  ]) {
    if (typeof candidate !== 'boolean') throw new TenantBackupSelectionError();
  }
  if (![7, 30, 90, 'all'].includes(logs.period as number | string)) {
    throw new TenantBackupSelectionError();
  }
  if (
    !root.settings &&
    !root.users &&
    !root.admin &&
    !root.artifacts &&
    !logs.audit &&
    !logs.other &&
    !logs.sensitive
  ) {
    throw new TenantBackupSelectionError();
  }
  // Return a detached value; a request object must not mutate an already planned selection.
  return {
    settings: root.settings as boolean,
    users: root.users as boolean,
    admin: root.admin as boolean,
    artifacts: root.artifacts as boolean,
    logs: {
      audit: logs.audit as boolean,
      other: logs.other as boolean,
      sensitive: logs.sensitive as boolean,
      period: logs.period as TenantBackupSelection['logs']['period'],
    },
  };
}

export type TenantDatasetSelectionRule =
  | { action: 'selected'; timeFilter: 'none' | 'log_window' }
  | { action: 'excluded'; reason: 'not_selected' | 'ephemeral' }
  | { action: 'resolve_references'; purpose: 'logs' | 'artifacts' | 'delivery_state' }
  | { action: 'prerequisite' }
  | { action: 'rebuild' };

/**
 * A planning rule, not an export predicate. Every selected row still needs ownership,
 * field/secret authorization, module coverage and dependency validation. Mixed catalogs
 * must be traversed from selected records; their entire tables are never selected here.
 */
export function tenantDatasetSelectionRule(
  kind: TenantDatasetKind,
  selection: TenantBackupSelection
): TenantDatasetSelectionRule {
  const selected = (include: boolean, logs = false): TenantDatasetSelectionRule =>
    include
      ? { action: 'selected', timeFilter: logs ? 'log_window' : 'none' }
      : { action: 'excluded', reason: 'not_selected' };
  switch (kind) {
    case 'settings':
    case 'users':
    case 'admin':
      return selected(selection[kind]);
    case 'audit':
      return selected(selection.logs.audit, true);
    case 'history':
      return selected(selection.logs.other, true);
    case 'sensitive_logs':
      return selected(selection.logs.sensitive, true);
    case 'log_dependencies':
      return { action: 'resolve_references', purpose: 'logs' };
    case 'artifacts':
      // Required bodies are dependencies even when optional historical files are OFF.
      return { action: 'resolve_references', purpose: 'artifacts' };
    case 'delivery_state':
      // The adapter resolves the originating category. Optional log settings never
      // control live delivery state, and restored old work must remain held.
      return { action: 'resolve_references', purpose: 'delivery_state' };
    case 'external':
      return { action: 'prerequisite' };
    case 'rebuild':
      return { action: 'rebuild' };
    case 'ephemeral':
      return { action: 'excluded', reason: 'ephemeral' };
    default: {
      const unknownKind: never = kind;
      void unknownKind;
      throw new Error('unknown_tenant_dataset_kind');
    }
  }
}

/** Resolve once from the pinned boundary, never from the current time on each page. */
export function tenantBackupLogWindow(
  period: TenantBackupSelection['logs']['period'],
  boundaryUnixMs: number
): { fromInclusiveUnixMs: number | null; untilInclusiveUnixMs: number } {
  if (
    !Number.isSafeInteger(boundaryUnixMs) ||
    boundaryUnixMs < 0 ||
    ![7, 30, 90, 'all'].includes(period)
  ) {
    throw new TenantBackupSelectionError();
  }
  return {
    fromInclusiveUnixMs:
      period === 'all' ? null : Math.max(0, boundaryUnixMs - period * 86_400_000),
    untilInclusiveUnixMs: boundaryUnixMs,
  };
}

/** Logical dependency edge. Physical DB IDs, bucket names and URLs are not identities. */
export interface TenantPortableReference {
  module: string;
  collection: string;
  id: string;
  tenantId: string;
  meaning: 'resource' | 'user' | 'admin_actor' | 'admin_principal' | 'asset' | 'secret';
  requirement: 'required' | 'provenance';
}

export interface TenantPortableSourceIdentity {
  tenantId: string;
  issuer: string;
  productVersion: string;
}

/** Multiple independent snapshots are inputs to one plan, not one alleged snapshot. */
export interface TenantPortableImportPlanIdentity {
  contractVersion: 1;
  mode: 'fresh_restore';
  source: TenantPortableSourceIdentity;
  inputs: readonly {
    bundleId: string;
    digestSha256: string;
    snapshotId: string;
    boundaryUnixMs: number;
    selection: TenantBackupSelection;
  }[];
  targetInitialFingerprintSha256: string;
  adminMappings: readonly { sourceAdminId: string; targetAdminId: string }[];
  // Fixed initial behavior. A future mode requires its own explicit version/validation.
  logicalIdentityPolicy: 'preserve';
  restoredDeliveryPolicy: 'hold_existing';
}
