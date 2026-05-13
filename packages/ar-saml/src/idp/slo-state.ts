import { DEFAULTS } from '../common/constants';

export interface SAMLOutboundLogoutRequestStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export interface SAMLLogoutFanoutTransactionStore extends SAMLOutboundLogoutRequestStore {
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface SAMLOutboundLogoutRequestRecord {
  tenantId: string;
  spEntityId: string;
  requestId: string;
  transactionId?: string;
  issuedAt: number;
  expiresAt: number;
}

export type SAMLIdPLogoutFanoutTargetStatus =
  | 'pending'
  | 'sent'
  | 'succeeded'
  | 'failed'
  | 'timeout';

export interface SAMLIdPLogoutFanoutTargetRecord {
  spEntityId: string;
  status: SAMLIdPLogoutFanoutTargetStatus;
  requestId?: string;
  sentAt?: number;
  completedAt?: number;
  statusCode?: string;
  statusMessage?: string;
  failureReason?: string;
}

export interface SAMLIdPLogoutFanoutTransactionRecord {
  transactionId: string;
  tenantId: string;
  userId: string;
  sessionIndex?: string;
  relayState?: string;
  issuedAt: number;
  expiresAt: number;
  targets: SAMLIdPLogoutFanoutTargetRecord[];
}

export interface SAMLIdPLogoutFanoutObservationResult {
  scanned: number;
  updated: number;
  timedOutTransactions: SAMLIdPLogoutFanoutTransactionRecord[];
}

export const SAML_IDP_LOGOUT_FANOUT_TRANSACTION_PREFIX = 'saml:logout-fanout:tenant:';
export const SAML_LOGOUT_FANOUT_OBSERVATION_RETENTION_SECONDS = 24 * 60 * 60;

export class SAMLLogoutResponseCorrelationError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SAMLLogoutResponseCorrelationError';
  }
}

export function buildSAMLOutboundLogoutRequestKey(tenantId: string, requestId: string): string {
  return `saml:logout-request:tenant:${tenantId}:id:${requestId}`;
}

export function buildSAMLIdPLogoutFanoutTransactionKey(
  tenantId: string,
  transactionId: string
): string {
  return `saml:logout-fanout:tenant:${tenantId}:id:${transactionId}`;
}

export async function storeSAMLOutboundLogoutRequest(
  store: Pick<SAMLOutboundLogoutRequestStore, 'put'>,
  options: {
    tenantId: string;
    spEntityId: string;
    requestId: string;
    transactionId?: string;
    ttlSeconds?: number;
  }
): Promise<void> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULTS.REQUEST_VALIDITY_SECONDS;
  const issuedAt = Date.now();

  await store.put(
    buildSAMLOutboundLogoutRequestKey(options.tenantId, options.requestId),
    JSON.stringify({
      version: 1,
      tenantId: options.tenantId,
      spEntityId: options.spEntityId,
      requestId: options.requestId,
      transactionId: options.transactionId,
      issuedAt,
      expiresAt: issuedAt + ttlSeconds * 1000,
    }),
    { expirationTtl: ttlSeconds }
  );
}

export async function consumeSAMLOutboundLogoutRequest(
  store: Pick<SAMLOutboundLogoutRequestStore, 'get' | 'delete'>,
  options: {
    tenantId: string;
    spEntityId: string;
    inResponseTo?: string;
  }
): Promise<SAMLOutboundLogoutRequestRecord> {
  const record = await getSAMLOutboundLogoutRequest(store, options);
  await deleteSAMLOutboundLogoutRequest(store, {
    tenantId: options.tenantId,
    requestId: record.requestId,
  });
  return record;
}

export async function getSAMLOutboundLogoutRequest(
  store: Pick<SAMLOutboundLogoutRequestStore, 'get'>,
  options: {
    tenantId: string;
    spEntityId: string;
    inResponseTo?: string;
  }
): Promise<SAMLOutboundLogoutRequestRecord> {
  if (!options.inResponseTo) {
    throw new SAMLLogoutResponseCorrelationError('LogoutResponse missing InResponseTo', {
      sp_entity_id: options.spEntityId,
    });
  }

  const key = buildSAMLOutboundLogoutRequestKey(options.tenantId, options.inResponseTo);
  const stored = await store.get(key);
  if (!stored) {
    throw new SAMLLogoutResponseCorrelationError(
      'LogoutResponse InResponseTo does not match an outbound LogoutRequest',
      {
        sp_entity_id: options.spEntityId,
        in_response_to: options.inResponseTo,
      }
    );
  }

  const parsed = parseOutboundLogoutRequestRecord(stored);
  if (!parsed || parsed.tenantId !== options.tenantId || parsed.spEntityId !== options.spEntityId) {
    throw new SAMLLogoutResponseCorrelationError(
      'LogoutResponse InResponseTo matched an invalid outbound LogoutRequest record',
      {
        sp_entity_id: options.spEntityId,
        in_response_to: options.inResponseTo,
      }
    );
  }

  if (parsed.expiresAt <= Date.now()) {
    throw new SAMLLogoutResponseCorrelationError('LogoutResponse InResponseTo record expired', {
      sp_entity_id: options.spEntityId,
      in_response_to: options.inResponseTo,
    });
  }

  return parsed;
}

export async function createSAMLIdPLogoutFanoutTransaction(
  store: Pick<SAMLOutboundLogoutRequestStore, 'put'>,
  options: {
    tenantId: string;
    userId: string;
    targets: string[];
    transactionId?: string;
    sessionIndex?: string;
    relayState?: string;
    ttlSeconds?: number;
  }
): Promise<SAMLIdPLogoutFanoutTransactionRecord> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULTS.REQUEST_VALIDITY_SECONDS;
  const issuedAt = Date.now();
  const transaction: SAMLIdPLogoutFanoutTransactionRecord = {
    transactionId: options.transactionId ?? crypto.randomUUID(),
    tenantId: options.tenantId,
    userId: options.userId,
    sessionIndex: options.sessionIndex,
    relayState: options.relayState,
    issuedAt,
    expiresAt: issuedAt + ttlSeconds * 1000,
    targets: Array.from(new Set(options.targets)).map((spEntityId) => ({
      spEntityId,
      status: 'pending',
    })),
  };

  await putSAMLIdPLogoutFanoutTransaction(store, transaction);
  return transaction;
}

export async function getSAMLIdPLogoutFanoutTransaction(
  store: Pick<SAMLOutboundLogoutRequestStore, 'get'>,
  options: {
    tenantId: string;
    transactionId: string;
  }
): Promise<SAMLIdPLogoutFanoutTransactionRecord | null> {
  const stored = await store.get(
    buildSAMLIdPLogoutFanoutTransactionKey(options.tenantId, options.transactionId)
  );
  if (!stored) {
    return null;
  }

  const parsed = parseSAMLIdPLogoutFanoutTransactionRecord(stored);
  if (!parsed || parsed.tenantId !== options.tenantId) {
    return null;
  }

  return parsed;
}

export async function markSAMLIdPLogoutFanoutTargetSent(
  store: Pick<SAMLOutboundLogoutRequestStore, 'get' | 'put'>,
  options: {
    tenantId: string;
    transactionId: string;
    spEntityId: string;
    requestId: string;
  }
): Promise<SAMLIdPLogoutFanoutTransactionRecord | null> {
  return updateSAMLIdPLogoutFanoutTarget(store, options, (target, now) => ({
    ...target,
    status: 'sent',
    requestId: options.requestId,
    sentAt: now,
  }));
}

export async function markSAMLIdPLogoutFanoutTargetCompleted(
  store: Pick<SAMLOutboundLogoutRequestStore, 'get' | 'put'>,
  options: {
    tenantId: string;
    transactionId: string;
    spEntityId: string;
    status: Extract<SAMLIdPLogoutFanoutTargetStatus, 'succeeded' | 'failed' | 'timeout'>;
    statusCode?: string;
    statusMessage?: string;
    failureReason?: string;
  }
): Promise<SAMLIdPLogoutFanoutTransactionRecord | null> {
  return updateSAMLIdPLogoutFanoutTarget(store, options, (target, now) => ({
    ...target,
    status: options.status,
    completedAt: now,
    statusCode: options.statusCode,
    statusMessage: options.statusMessage,
    failureReason: options.failureReason,
  }));
}

export function getNextPendingSAMLIdPLogoutFanoutTarget(
  transaction: SAMLIdPLogoutFanoutTransactionRecord,
  now = Date.now()
): SAMLIdPLogoutFanoutTargetRecord | null {
  if (transaction.expiresAt <= now) {
    return null;
  }

  return transaction.targets.find((target) => target.status === 'pending') ?? null;
}

export function isSAMLIdPLogoutFanoutTransactionComplete(
  transaction: SAMLIdPLogoutFanoutTransactionRecord
): boolean {
  return transaction.targets.every((target) =>
    ['succeeded', 'failed', 'timeout'].includes(target.status)
  );
}

export function observeExpiredSAMLIdPLogoutFanoutTransaction(
  transaction: SAMLIdPLogoutFanoutTransactionRecord,
  now = Date.now()
): SAMLIdPLogoutFanoutTransactionRecord | null {
  if (transaction.expiresAt > now || isSAMLIdPLogoutFanoutTransactionComplete(transaction)) {
    return null;
  }

  let changed = false;
  const targets = transaction.targets.map((target) => {
    if (target.status !== 'pending' && target.status !== 'sent') {
      return target;
    }

    changed = true;
    return {
      ...target,
      status: 'timeout' as const,
      completedAt: now,
      failureReason: target.status === 'sent' ? 'logout_response_timeout' : 'logout_request_not_sent',
    };
  });

  return changed ? { ...transaction, targets } : null;
}

export async function observeExpiredSAMLIdPLogoutFanoutTransactions(
  store: SAMLLogoutFanoutTransactionStore,
  options: {
    now?: number;
    limit?: number;
  } = {}
): Promise<SAMLIdPLogoutFanoutObservationResult> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 100;
  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;
  const timedOutTransactions: SAMLIdPLogoutFanoutTransactionRecord[] = [];

  do {
    const page = await store.list({
      prefix: SAML_IDP_LOGOUT_FANOUT_TRANSACTION_PREFIX,
      cursor,
      limit,
    });
    cursor = page.cursor;

    for (const key of page.keys) {
      const stored = await store.get(key.name);
      if (!stored) {
        continue;
      }
      scanned += 1;

      const transaction = parseSAMLIdPLogoutFanoutTransactionRecord(stored);
      if (!transaction) {
        continue;
      }

      const observed = observeExpiredSAMLIdPLogoutFanoutTransaction(transaction, now);
      if (!observed) {
        continue;
      }

      await putSAMLIdPLogoutFanoutTransaction(store, observed);
      updated += 1;
      timedOutTransactions.push(observed);
    }

    if (page.list_complete) {
      break;
    }
  } while (cursor);

  return { scanned, updated, timedOutTransactions };
}

export async function deleteSAMLOutboundLogoutRequest(
  store: Pick<SAMLOutboundLogoutRequestStore, 'delete'>,
  options: {
    tenantId: string;
    requestId: string;
  }
): Promise<void> {
  await store.delete(buildSAMLOutboundLogoutRequestKey(options.tenantId, options.requestId));
}

async function updateSAMLIdPLogoutFanoutTarget(
  store: Pick<SAMLOutboundLogoutRequestStore, 'get' | 'put'>,
  options: {
    tenantId: string;
    transactionId: string;
    spEntityId: string;
  },
  update: (
    target: SAMLIdPLogoutFanoutTargetRecord,
    now: number
  ) => SAMLIdPLogoutFanoutTargetRecord
): Promise<SAMLIdPLogoutFanoutTransactionRecord | null> {
  const transaction = await getSAMLIdPLogoutFanoutTransaction(store, options);
  if (!transaction) {
    return null;
  }

  const now = Date.now();
  const updated = {
    ...transaction,
    targets: transaction.targets.map((target) =>
      target.spEntityId === options.spEntityId ? update(target, now) : target
    ),
  };
  await putSAMLIdPLogoutFanoutTransaction(store, updated);
  return updated;
}

async function putSAMLIdPLogoutFanoutTransaction(
  store: Pick<SAMLOutboundLogoutRequestStore, 'put'>,
  transaction: SAMLIdPLogoutFanoutTransactionRecord,
  ttlSeconds?: number
): Promise<void> {
  const now = Date.now();
  const effectiveTtlSeconds = Math.max(
    1,
    ttlSeconds ??
      Math.ceil((transaction.expiresAt - now) / 1000) +
        SAML_LOGOUT_FANOUT_OBSERVATION_RETENTION_SECONDS
  );
  await store.put(
    buildSAMLIdPLogoutFanoutTransactionKey(transaction.tenantId, transaction.transactionId),
    JSON.stringify({ version: 1, ...transaction }),
    { expirationTtl: effectiveTtlSeconds }
  );
}

function parseOutboundLogoutRequestRecord(
  value: string
): SAMLOutboundLogoutRequestRecord | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.tenantId !== 'string' ||
      typeof parsed.spEntityId !== 'string' ||
      typeof parsed.requestId !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }

    return {
      tenantId: parsed.tenantId,
      spEntityId: parsed.spEntityId,
      requestId: parsed.requestId,
      transactionId: typeof parsed.transactionId === 'string' ? parsed.transactionId : undefined,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function parseSAMLIdPLogoutFanoutTransactionRecord(
  value: string
): SAMLIdPLogoutFanoutTransactionRecord | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.transactionId !== 'string' ||
      typeof parsed.tenantId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.expiresAt !== 'number' ||
      !Array.isArray(parsed.targets)
    ) {
      return null;
    }

    const targets = parsed.targets
      .map(parseSAMLIdPLogoutFanoutTargetRecord)
      .filter((target): target is SAMLIdPLogoutFanoutTargetRecord => Boolean(target));
    if (targets.length !== parsed.targets.length) {
      return null;
    }

    return {
      transactionId: parsed.transactionId,
      tenantId: parsed.tenantId,
      userId: parsed.userId,
      sessionIndex: typeof parsed.sessionIndex === 'string' ? parsed.sessionIndex : undefined,
      relayState: typeof parsed.relayState === 'string' ? parsed.relayState : undefined,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
      targets,
    };
  } catch {
    return null;
  }
}

function parseSAMLIdPLogoutFanoutTargetRecord(
  value: unknown
): SAMLIdPLogoutFanoutTargetRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const parsed = value as Record<string, unknown>;
  if (typeof parsed.spEntityId !== 'string' || !isSAMLIdPLogoutFanoutTargetStatus(parsed.status)) {
    return null;
  }

  return {
    spEntityId: parsed.spEntityId,
    status: parsed.status,
    requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined,
    sentAt: typeof parsed.sentAt === 'number' ? parsed.sentAt : undefined,
    completedAt: typeof parsed.completedAt === 'number' ? parsed.completedAt : undefined,
    statusCode: typeof parsed.statusCode === 'string' ? parsed.statusCode : undefined,
    statusMessage: typeof parsed.statusMessage === 'string' ? parsed.statusMessage : undefined,
    failureReason: typeof parsed.failureReason === 'string' ? parsed.failureReason : undefined,
  };
}

function isSAMLIdPLogoutFanoutTargetStatus(
  value: unknown
): value is SAMLIdPLogoutFanoutTargetStatus {
  return (
    value === 'pending' ||
    value === 'sent' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'timeout'
  );
}
