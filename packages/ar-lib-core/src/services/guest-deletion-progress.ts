import { parseGuestDeletionReceiptV2, type GuestDeletionReceiptV2 } from './guest-deletion-receipt';

export const GUEST_DELETION_STAGES = [
  'capture_email',
  'capture_linked',
  'capture_passkeys',
  'capture_resume',
  'release_reservations',
  'drain_pii',
  'drain_guest_devices',
  'drain_passkeys',
  'drain_totp_backup_codes',
  'drain_totp_credentials',
  'final_core',
  'directory_ready',
  'compact_pii',
  'terminal',
] as const;
export type GuestDeletionStage = (typeof GUEST_DELETION_STAGES)[number];
export interface GuestCorePagePermit {
  table:
    | 'passkeys'
    | 'guest_devices'
    | 'totp_backup_codes'
    | 'totp_credentials'
    | 'identity_accounts';
  ids: string[];
}
export interface GuestDeletionProgress {
  schemaVersion: 1;
  revision: number;
  receiptDigest: string;
  stage: GuestDeletionStage;
  sourceOrdinal: number;
  cursor: string | null;
  highWater: string | null;
  preparedCount: number;
  confirmedCount: number;
  pinnedHmacGenerations: number[];
  corePermit: GuestCorePagePermit | null;
}
function invalid(): never {
  throw new Error('guest_deletion_progress_invalid');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    Object.keys(result).some((key) => !keys.includes(key))
  )
    return invalid();
  return result;
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    return invalid();
  return value;
}
function key(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    new TextEncoder().encode(value).length > 256 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return invalid();
  return value;
}
/** The transient permit is valid only inside an ordered atomic batch and must clear before commit. */
export function parseGuestDeletionProgress(json: string): GuestDeletionProgress {
  if (json.length > 16384 || new TextEncoder().encode(json).length > 16384) return invalid();
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return invalid();
  }
  const input = object(value, [
    'schemaVersion',
    'revision',
    'receiptDigest',
    'stage',
    'sourceOrdinal',
    'cursor',
    'highWater',
    'preparedCount',
    'confirmedCount',
    'pinnedHmacGenerations',
    'corePermit',
  ]);
  if (
    input.schemaVersion !== 1 ||
    typeof input.receiptDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.receiptDigest)
  )
    return invalid();
  const stage = GUEST_DELETION_STAGES.find((entry) => entry === input.stage);
  if (!stage) return invalid();
  if (
    !Array.isArray(input.pinnedHmacGenerations) ||
    input.pinnedHmacGenerations.length < 1 ||
    input.pinnedHmacGenerations.length > 2
  )
    return invalid();
  const generations = input.pinnedHmacGenerations.map((generation: unknown) =>
    integer(generation, 1)
  );
  if (new Set(generations).size !== generations.length) return invalid();
  let corePermit: GuestCorePagePermit | null = null;
  if (input.corePermit !== null) {
    const permit = object(input.corePermit, ['table', 'ids']);
    if (
      permit.table !== 'passkeys' &&
      permit.table !== 'guest_devices' &&
      permit.table !== 'totp_backup_codes' &&
      permit.table !== 'totp_credentials' &&
      permit.table !== 'identity_accounts'
    )
      return invalid();
    if (!Array.isArray(permit.ids) || permit.ids.length < 1 || permit.ids.length > 16)
      return invalid();
    const ids = permit.ids.map((id: unknown) => key(id));
    if (
      new Set(ids).size !== ids.length ||
      (permit.table === 'identity_accounts' && ids.length !== 1)
    )
      return invalid();
    corePermit = { table: permit.table, ids };
  }
  if (
    corePermit &&
    input.stage !==
      (corePermit.table === 'identity_accounts' ? 'final_core' : `drain_${corePermit.table}`)
  )
    return invalid();
  if (
    integer(input.confirmedCount) > integer(input.preparedCount) ||
    (input.cursor !== null && input.highWater === null)
  )
    return invalid();
  const sourceOrdinal = integer(input.sourceOrdinal);
  if (sourceOrdinal > 32) return invalid();
  return {
    schemaVersion: 1,
    revision: integer(input.revision, 1),
    receiptDigest: input.receiptDigest,
    stage,
    sourceOrdinal,
    cursor: input.cursor === null ? null : key(input.cursor),
    highWater: input.highWater === null ? null : key(input.highWater),
    preparedCount: integer(input.preparedCount),
    confirmedCount: integer(input.confirmedCount),
    pinnedHmacGenerations: generations,
    corePermit,
  };
}
export async function guestDeletionReceiptDigest(route: GuestDeletionReceiptV2): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(
        parseGuestDeletionReceiptV2(JSON.stringify(route), {
          tenantId: route.tenantId,
          userId: route.userId,
          accountId: route.accountId,
          operationId: route.operationId,
        })
      )
    )
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function createGuestDeletionProgress(
  route: GuestDeletionReceiptV2,
  pinnedHmacGenerations: number[]
): Promise<GuestDeletionProgress> {
  if (route.execution.phase !== 'erasure_started') return invalid();
  return parseGuestDeletionProgress(
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      receiptDigest: await guestDeletionReceiptDigest(route),
      stage: 'capture_email',
      sourceOrdinal: 0,
      cursor: null,
      highWater: null,
      preparedCount: 0,
      confirmedCount: 0,
      pinnedHmacGenerations,
      corePermit: null,
    })
  );
}
