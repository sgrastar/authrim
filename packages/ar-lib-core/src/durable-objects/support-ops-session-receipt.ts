/** Private durable transfer of the sessions ended by a Support Ops suspension. */
export const SUPPORT_OPS_RECEIPT_SCAN_SIZE = 100;
export const SUPPORT_OPS_RECEIPT_PAGE_SIZE = 10;
const RECEIPT_KEY = 'support-ops-session-receipt';
const ITEMS = 'support-ops-session-receipt-item:';
const INDEX = 'session-index:';
const LEASE_MS = 60_000;

export interface ReceiptStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; limit: number; startAfter?: string }): Promise<Map<string, T>>;
}
interface IndexedSession {
  sessionId: string;
  expiresAtMs: number;
  revocationBoundAtMs: number;
}
interface Receipt {
  operationId: string;
  sourceVersionMs: number;
  previous: number | null;
  next: number | null;
  capturedAtMs: number;
  scanCursor: string;
  scanDone: boolean;
  complete: boolean;
  sequence: number;
  readSequence: number | null;
  owner: string;
  fence: number;
  leaseUntil: number;
}
export interface SupportOpsSessionReceiptLease {
  stage: 'scanning' | 'ready' | 'drained' | 'complete';
  fence: number;
  sequence: number;
}
export interface SupportOpsSessionReceiptPage extends SupportOpsSessionReceiptLease {
  sessionIds: string[];
}
export interface ReceiptRequest {
  operationId: string;
  sourceVersionMs: number;
  owner: string;
  nowMs: number;
}
function view(receipt: Receipt): SupportOpsSessionReceiptLease {
  return {
    stage: receipt.complete ? 'complete' : receipt.scanDone ? 'ready' : 'scanning',
    fence: receipt.fence,
    sequence: receipt.sequence,
  };
}
function matching(receipt: Receipt, entry: IndexedSession): boolean {
  return (
    receipt.next !== null &&
    entry.expiresAtMs > receipt.capturedAtMs &&
    entry.revocationBoundAtMs <= receipt.next &&
    (receipt.previous === null || entry.revocationBoundAtMs > receipt.previous)
  );
}
function validTime(now: number) {
  if (!Number.isSafeInteger(now) || now < 1 || now > Number.MAX_SAFE_INTEGER - LEASE_MS)
    throw new Error('support_ops_receipt_time_invalid');
}
function hold(receipt: Receipt, owner: string, now: number, fence?: number) {
  validTime(now);
  if (
    (fence !== undefined && receipt.fence !== fence) ||
    (receipt.owner !== owner && receipt.leaseUntil > now) ||
    (fence !== undefined && (receipt.owner !== owner || receipt.leaseUntil <= now))
  )
    throw new Error('support_ops_receipt_lease_lost');
  if (receipt.owner !== owner) receipt.fence += 1;
  if (!Number.isSafeInteger(receipt.fence)) throw new Error('support_ops_receipt_fence_invalid');
  receipt.owner = owner;
  receipt.leaseUntil = Math.max(receipt.leaseUntil, now + LEASE_MS);
}
/** Call inside the lifecycle transaction, before applying a new transition. */
export async function replaySupportOpsReceipt(
  storage: ReceiptStorage,
  input: ReceiptRequest
): Promise<SupportOpsSessionReceiptLease | null> {
  const receipt = await storage.get<Receipt>(RECEIPT_KEY);
  if (!receipt) return null;
  if (
    receipt.operationId !== input.operationId ||
    receipt.sourceVersionMs !== input.sourceVersionMs
  ) {
    if (!receipt.complete) throw new Error('support_ops_receipt_busy');
    return null;
  }
  hold(receipt, input.owner, input.nowMs);
  await storage.put(RECEIPT_KEY, receipt);
  return view(receipt);
}
/** Store in the same transaction as the new lifecycle/epoch. No session array crosses RPC. */
export async function createSupportOpsReceipt(
  storage: ReceiptStorage,
  input: ReceiptRequest,
  previous: number | null,
  next: number | null
): Promise<SupportOpsSessionReceiptLease> {
  validTime(input.nowMs);
  const prior = await storage.get<Receipt>(RECEIPT_KEY);
  const receipt: Receipt = {
    ...input,
    capturedAtMs: input.nowMs,
    previous,
    next,
    scanCursor: '',
    scanDone: false,
    complete: false,
    sequence: 0,
    readSequence: null,
    fence: (prior?.fence ?? 0) + 1,
    leaseUntil: input.nowMs + LEASE_MS,
  };
  if (!Number.isSafeInteger(receipt.fence)) throw new Error('support_ops_receipt_fence_invalid');
  await storage.put(RECEIPT_KEY, receipt);
  return view(receipt);
}
/** Preserve an entry before removal/overwrite while the snapshot's scan is incomplete. */
export async function capturePendingSupportOpsSession(
  storage: ReceiptStorage,
  entry: IndexedSession | undefined,
  validateSessionId: (id: string) => string
): Promise<void> {
  if (!entry) return;
  const receipt = await storage.get<Receipt>(RECEIPT_KEY);
  if (receipt && !receipt.complete && !receipt.scanDone && matching(receipt, entry)) {
    const id = validateSessionId(entry.sessionId);
    await storage.put(ITEMS + id, id);
  }
}
async function claimed(
  storage: ReceiptStorage,
  operationId: string,
  owner: string,
  fence: number,
  now: number
): Promise<Receipt> {
  const receipt = await storage.get<Receipt>(RECEIPT_KEY);
  if (!receipt || receipt.operationId !== operationId)
    throw new Error('support_ops_receipt_missing');
  hold(receipt, owner, now, fence);
  return receipt;
}
/** One bounded scan page, or one stable transfer page. No automatic expiry of unacknowledged IDs. */
export async function stepSupportOpsReceipt(
  storage: ReceiptStorage,
  operationId: string,
  owner: string,
  fence: number,
  now: number,
  validateSessionId: (id: string) => string
): Promise<SupportOpsSessionReceiptPage> {
  const receipt = await claimed(storage, operationId, owner, fence, now);
  if (!receipt.complete && !receipt.scanDone) {
    const page = await storage.list<IndexedSession>({
      prefix: INDEX,
      limit: SUPPORT_OPS_RECEIPT_SCAN_SIZE,
      ...(receipt.scanCursor ? { startAfter: receipt.scanCursor } : {}),
    });
    for (const [key, entry] of page) {
      if (matching(receipt, entry)) {
        const id = validateSessionId(entry.sessionId);
        await storage.put(ITEMS + id, id);
      }
      receipt.scanCursor = key;
    }
    receipt.scanDone = page.size < SUPPORT_OPS_RECEIPT_SCAN_SIZE;
    await storage.put(RECEIPT_KEY, receipt);
    return { ...view(receipt), sessionIds: [] };
  }
  const page = receipt.complete
    ? new Map<string, string>()
    : await storage.list<string>({ prefix: ITEMS, limit: SUPPORT_OPS_RECEIPT_PAGE_SIZE });
  if (page.size > 0) receipt.readSequence = receipt.sequence;
  await storage.put(RECEIPT_KEY, receipt);
  return {
    ...view(receipt),
    ...(page.size === 0 && !receipt.complete ? { stage: 'drained' as const } : {}),
    sessionIds: [...page.values()].map(validateSessionId),
  };
}
/** ACK is sequence-idempotent. The caller first confirms the deterministic Admin logout job. */
export async function acknowledgeSupportOpsReceipt(
  storage: ReceiptStorage,
  operationId: string,
  owner: string,
  fence: number,
  sequence: number,
  now: number
): Promise<void> {
  const receipt = await claimed(storage, operationId, owner, fence, now);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > receipt.sequence)
    throw new Error('support_ops_receipt_sequence_invalid');
  if (sequence < receipt.sequence) return;
  if (receipt.complete || !receipt.scanDone || receipt.readSequence !== sequence)
    throw new Error('support_ops_receipt_page_not_read');
  const page = await storage.list<string>({ prefix: ITEMS, limit: SUPPORT_OPS_RECEIPT_PAGE_SIZE });
  if (page.size === 0) throw new Error('support_ops_receipt_page_empty');
  await storage.delete([...page.keys()]);
  receipt.sequence += 1;
  receipt.readSequence = null;
  await storage.put(RECEIPT_KEY, receipt);
}

/** The caller first persists Admin transferred=true, even for an empty receipt. */
export async function completeSupportOpsReceipt(
  storage: ReceiptStorage,
  operationId: string,
  sourceVersionMs: number,
  owner: string,
  fence: number,
  sequence: number,
  now: number
): Promise<void> {
  const current = await storage.get<Receipt>(RECEIPT_KEY);
  // Another Support Ops operation can replace only an acknowledged complete receipt.
  // This path does not mutate that newer operation. Admin's durable transfer evidence remains required.
  if (current && current.operationId !== operationId && current.sourceVersionMs > sourceVersionMs)
    return;
  const receipt = await claimed(storage, operationId, owner, fence, now);
  if (receipt.sourceVersionMs !== sourceVersionMs)
    throw new Error('support_ops_receipt_source_version_conflict');
  if (receipt.complete) return;
  if (
    !receipt.scanDone ||
    receipt.sequence !== sequence ||
    (await storage.list<string>({ prefix: ITEMS, limit: 1 })).size !== 0
  )
    throw new Error('support_ops_receipt_not_drained');
  receipt.complete = true;
  await storage.put(RECEIPT_KEY, receipt);
}
