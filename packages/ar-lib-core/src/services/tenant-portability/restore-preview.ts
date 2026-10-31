import {
  parsePhase4ExternalPrerequisites,
  type Phase4ExternalPrerequisite,
} from './phase4-external-prerequisites.js';
import {
  parsePhase5DeliverySafety,
  type Phase5DeliverySafetyEvidence,
} from './phase5-delivery-safety.js';

export interface TenantBackupRestoreBlocker {
  code: 'external_prerequisite_unresolved' | 'delivery_safety_unconfirmed';
  subjectId: string | null;
}

export interface TenantBackupRestorePreview {
  version: 1;
  planDigest: string;
  prerequisites: readonly Phase4ExternalPrerequisite[];
  deliverySafety: Phase5DeliverySafetyEvidence;
  blockers: readonly TenantBackupRestoreBlocker[];
}

interface TenantBackupRestoreApprovalCursor {
  version: 1;
  planDigest: string;
  restoreCursor: Record<string, unknown>;
  preview: TenantBackupRestorePreview;
}

function invalid(): never {
  throw new Error('backup_restore_preview_invalid');
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function createTenantBackupRestorePreview(input: {
  planDigest: string;
  prerequisites: unknown;
  deliverySafety: unknown;
}): TenantBackupRestorePreview {
  if (!/^[a-f0-9]{64}$/.test(input.planDigest)) invalid();
  const prerequisites = parsePhase4ExternalPrerequisites(input.prerequisites);
  const deliverySafety = parsePhase5DeliverySafety(input.deliverySafety);
  const blockers: TenantBackupRestoreBlocker[] = prerequisites
    .filter(({ required, status }) => required && status === 'unresolved')
    .map(({ id }) => ({ code: 'external_prerequisite_unresolved', subjectId: id }));
  if (
    deliverySafety.sourceEnvironment !== 'stopped' ||
    deliverySafety.historicalDelivery !== 'hold' ||
    deliverySafety.scheduledCatchup !== 'disabled' ||
    deliverySafety.activation !== 'new_events_only'
  )
    blockers.push({ code: 'delivery_safety_unconfirmed', subjectId: null });
  return {
    version: 1,
    planDigest: input.planDigest,
    prerequisites,
    deliverySafety,
    blockers,
  };
}

function parsePreview(value: unknown, planDigest: string): TenantBackupRestorePreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const preview = value as Record<string, unknown>;
  if (
    !exact(preview, ['version', 'planDigest', 'prerequisites', 'deliverySafety', 'blockers']) ||
    preview.version !== 1 ||
    preview.planDigest !== planDigest ||
    !Array.isArray(preview.blockers)
  )
    invalid();
  const normalized = createTenantBackupRestorePreview({
    planDigest,
    prerequisites: preview.prerequisites,
    deliverySafety: preview.deliverySafety,
  });
  if (JSON.stringify(normalized.blockers) !== JSON.stringify(preview.blockers)) invalid();
  return normalized;
}

export function encodeTenantBackupRestoreApprovalCursor(input: {
  planDigest: string;
  restoreCursor: string | null;
  preview: TenantBackupRestorePreview;
}): string {
  let restoreCursor: unknown;
  try {
    restoreCursor = JSON.parse(input.restoreCursor ?? 'null') as unknown;
  } catch {
    return invalid();
  }
  if (!restoreCursor || typeof restoreCursor !== 'object' || Array.isArray(restoreCursor))
    invalid();
  const value = JSON.stringify({
    version: 1,
    planDigest: input.planDigest,
    restoreCursor,
    preview: parsePreview(input.preview, input.planDigest),
  });
  if (new TextEncoder().encode(value).length > 16384) invalid();
  return value;
}

export function decodeTenantBackupRestoreApprovalCursor(
  value: string | null
): TenantBackupRestoreApprovalCursor {
  try {
    if (value === null || new TextEncoder().encode(value).length > 16384) invalid();
    const cursor = JSON.parse(value) as Record<string, unknown>;
    if (
      !cursor ||
      Array.isArray(cursor) ||
      !exact(cursor, ['version', 'planDigest', 'restoreCursor', 'preview']) ||
      cursor.version !== 1 ||
      typeof cursor.planDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(cursor.planDigest) ||
      !cursor.restoreCursor ||
      typeof cursor.restoreCursor !== 'object' ||
      Array.isArray(cursor.restoreCursor)
    )
      invalid();
    return {
      version: 1,
      planDigest: cursor.planDigest,
      restoreCursor: cursor.restoreCursor as Record<string, unknown>,
      preview: parsePreview(cursor.preview, cursor.planDigest),
    };
  } catch {
    return invalid();
  }
}
