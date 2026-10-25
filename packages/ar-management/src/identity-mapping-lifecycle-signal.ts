/**
 * Account suspension only. Admin idempotency remains in Admin; this journal belongs to tenant
 * metadata, while the canonical account and its subject belong to the pinned Core owner.
 * Pending is deliberately not a historical effect receipt: an unprovable result stays pending.
 */
import type { Context } from 'hono';
import {
  createAuthContextFromHono,
  getTenantMetadataContextFromHono,
  readAccountAuthenticationState,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { tenantCoreStores } from './compliance/tenant-stores';
import { usesRoutedAccountStorage } from './tenant-routed-storage';
import { transitionAccountLifecycle } from './account-status';
import { adminActorIdFromContext, startAdminSessionEndLogout } from './admin-session-end';
import { getAdminActorAuditMetadata, writeAdminAuditLog } from './admin-shared';

const REASONS = ['lifecycle_signal.scim_active_false'];
const PRIMARY = { consistencyClass: 'primary_required' } as const;

export class LifecycleSignalConflictError extends Error {}
export class LifecycleSignalInputError extends Error {}

export interface SuspensionSignalInput {
  sourceType: string;
  sourceId: string;
  sourceEventId: string;
  sourceTimestamp?: number | null;
  bindingVersion?: string | null;
  payloadRef?: string | null;
  signalType: 'scim_active_false';
  targetType: 'account';
  targetId: string;
  accountId?: string | null;
  subjectId?: string | null;
}

interface PhysicalIdentity {
  databaseId: string;
  bindingRouteGeneration: number;
  shardId: string;
  assignmentGeneration: number;
}
interface AccountPin {
  accountId: string;
  userId: string;
  subjectId: string | null;
  bindingRef: string;
  identity: PhysicalIdentity;
}
interface Owner extends AccountPin {
  adapter: DatabaseAdapter;
}
interface Descriptor {
  version: 1;
  targetType: 'account';
  targetId: string;
  requestHash: string;
  owner: AccountPin;
  actorId: string | null;
  actorType: string;
}
interface Event {
  id: string;
  tenant_id: string;
  source_type: string;
  source_id: string;
  source_event_id: string;
  source_timestamp: number | null;
  observed_at: number;
  binding_version: string | null;
  payload_ref: string | null;
  signal_type: string;
  dedupe_key: string;
  processing_state: string;
}
interface Decision {
  id: string;
  account_id: string | null;
  subject_id: string | null;
  decision: string;
  propagation_targets_json: string | null;
  reason_codes_json: string | null;
  created_at: number;
}

export interface AccountSuspensionSignalService {
  record(
    tenantId: string,
    input: SuspensionSignalInput,
    requestHash: string,
    completed?: { eventId: string }
  ): Promise<{
    signalEventId: string;
    decision: 'suspend_account';
    reasonCodes: string[];
    idempotent?: true;
  }>;
}

function requireIdentity(value: PhysicalIdentity | undefined): asserts value is PhysicalIdentity {
  if (
    !value ||
    typeof value.databaseId !== 'string' ||
    !value.databaseId ||
    typeof value.shardId !== 'string' ||
    !value.shardId ||
    !Number.isSafeInteger(value.bindingRouteGeneration) ||
    value.bindingRouteGeneration < 0 ||
    !Number.isSafeInteger(value.assignmentGeneration) ||
    value.assignmentGeneration < 0
  )
    throw new Error('lifecycle_signal_owner_identity_unavailable');
}
function pin(owner: Owner): AccountPin {
  const { adapter: _adapter, ...value } = owner;
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function conflict(): never {
  throw new LifecycleSignalConflictError('Lifecycle signal has no provable account outcome');
}
function requireSqlite(adapter: DatabaseAdapter): void {
  if (!['d1', 'sqlite'].includes(adapter.getType()))
    throw new Error('lifecycle_signal_adapter_unsupported');
}
async function mapFour<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++)
        results[index] = await read(items[index]);
    })
  );
  return results;
}

/** Core-only exact internal account ID lookup. No PII read or legacy-ID fallback. */
export async function resolveLifecycleSignalAccountOwner(
  c: Context<{ Bindings: Env }>,
  tenantId: string,
  accountId: string
): Promise<Owner> {
  const metadata = getTenantMetadataContextFromHono(c);
  const route = metadata?.route;
  const stores = usesRoutedAccountStorage(metadata)
    ? await tenantCoreStores(c.env, tenantId, {
        accountsOfRoutedTenant: true,
        purpose: 'lifecycle-signal',
      })
    : [
        {
          bindingRef: route?.bindingRef ?? '',
          identity: route?.registryRow?.database_id
            ? {
                databaseId: route.registryRow.database_id,
                bindingRouteGeneration: route.bindingRouteGeneration,
                shardId: route.shardId,
                assignmentGeneration: route.assignmentGeneration,
              }
            : undefined,
          adapter: createAuthContextFromHono(c, tenantId).coreAdapter,
        },
      ];
  if (!stores.length || stores.length > 64) throw new Error('lifecycle_signal_inventory_invalid');
  // Refuse unsupported/incomplete inventory before any authentication-state mutation.
  for (const store of stores) {
    requireSqlite(store.adapter);
    requireIdentity(store.identity);
    if (!store.bindingRef) throw new Error('lifecycle_signal_binding_unavailable');
  }
  const matches = (
    await mapFour(stores, async (store) => {
      const row = await store.adapter.queryOne<{
        id: string;
        legacy_user_id: string | null;
        primary_subject_id: string | null;
        lifecycle_state: string;
      }>(
        'SELECT id, legacy_user_id, primary_subject_id, lifecycle_state FROM identity_accounts WHERE tenant_id = ? AND id = ?',
        [tenantId, accountId],
        PRIMARY
      );
      if (!row) return null;
      if (row.lifecycle_state === 'deleting' || row.lifecycle_state === 'deleted') conflict();
      if (!row.legacy_user_id) throw new Error('lifecycle_signal_account_subject_unavailable');
      requireIdentity(store.identity);
      return {
        accountId: row.id,
        userId: row.legacy_user_id,
        subjectId: row.primary_subject_id,
        bindingRef: store.bindingRef,
        identity: store.identity,
        adapter: store.adapter,
      };
    })
  ).filter((value): value is Owner => value !== null);
  if (matches.length !== 1) throw new Error('lifecycle_signal_account_owner_not_unique');
  const owner = matches[0];
  // The canonical helper takes a legacy user ID; never let that select another account.
  const users = await mapFour(stores, (store) =>
    store.adapter.query<{ id: string }>(
      'SELECT id FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ? LIMIT 2',
      [tenantId, owner.userId],
      PRIMARY
    )
  );
  const rows = users.flat();
  if (rows.length !== 1 || rows[0].id !== owner.accountId) conflict();
  return owner;
}

export function createAccountSuspensionSignalService(
  c: Context<{ Bindings: Env }>,
  metadata: DatabaseAdapter,
  now: () => number = Date.now
): AccountSuspensionSignalService {
  const adminAuth = (c as unknown as { get(key: string): unknown }).get('adminAuth') as
    | AdminAuthContext
    | undefined;
  const actor = getAdminActorAuditMetadata(adminAuth);
  return {
    record: (tenantId, input, requestHash, completed) =>
      recordAccountSuspensionSignal({
        env: c.env,
        metadata,
        tenantId,
        input,
        requestHash,
        completedEventId: completed?.eventId,
        now,
        actorId: adminActorIdFromContext(c) ?? null,
        actorType: String(actor.admin_actor_type),
        resolveOwner: () => resolveLifecycleSignalAccountOwner(c, tenantId, input.targetId),
        sessionsEnded: async (eventId, owner, actorId, sessionIds) =>
          startAdminSessionEndLogout(c, {
            tenantId,
            sessions: sessionIds.map((sessionId) => ({ userId: owner.userId, sessionId })),
            trigger: {
              action: 'user.suspend',
              operationId: eventId,
              ...(actorId ? { actorId } : {}),
            },
          }),
        audit: async (eventId, descriptor, result) => {
          await writeAdminAuditLog(c, {
            action: 'identity_mapping.lifecycle_signal.suspend_account',
            resourceType: 'account',
            resourceId: descriptor.owner.accountId,
            result,
            metadata: {
              signal_event_id: eventId,
              original_actor_id: descriptor.actorId,
              original_actor_type: descriptor.actorType,
              decision: 'suspend_account',
              reason_codes: REASONS,
            },
          });
        },
      }),
  };
}

interface RecordOptions {
  env: Env;
  metadata: DatabaseAdapter;
  tenantId: string;
  input: SuspensionSignalInput;
  requestHash: string;
  completedEventId?: string;
  now: () => number;
  actorId: string | null;
  actorType: string;
  resolveOwner: () => Promise<Owner>;
  sessionsEnded: (
    eventId: string,
    owner: AccountPin,
    actorId: string | null,
    sessions: string[]
  ) => Promise<void>;
  audit: (eventId: string, descriptor: Descriptor, result: 'success' | 'failure') => Promise<void>;
}

/** Public for actual-SQL tests; the HTTP repository owns validation and Admin idempotency. */
export async function recordAccountSuspensionSignal(options: RecordOptions) {
  const { metadata, tenantId, input, requestHash } = options;
  requireSqlite(metadata);
  if (!/^[a-f0-9]{64}$/u.test(requestHash)) throw new Error('lifecycle_signal_hash_invalid');
  const observedAt = options.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 1)
    throw new Error('lifecycle_signal_time_invalid');
  if (
    input.sourceTimestamp != null &&
    (!Number.isSafeInteger(input.sourceTimestamp) || input.sourceTimestamp < 0)
  )
    throw new LifecycleSignalInputError('sourceTimestamp must be a nonnegative safe integer');
  for (const value of [input.bindingVersion, input.payloadRef]) {
    if (value != null && typeof value !== 'string')
      throw new LifecycleSignalInputError('Signal references must be strings');
  }
  const dedupeKey = [
    input.sourceType,
    input.sourceId,
    input.sourceEventId,
    input.signalType,
    input.targetType,
    input.targetId,
  ].join(':');
  const eventKey = [tenantId, input.sourceType, input.sourceId, dedupeKey];
  const readEvent = () =>
    metadata.queryOne<Event>(
      `SELECT id, tenant_id, source_type, source_id, source_event_id, source_timestamp, observed_at,
            binding_version, payload_ref, signal_type, dedupe_key, processing_state
       FROM external_lifecycle_signal_events
      WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND dedupe_key = ? LIMIT 1`,
      eventKey,
      PRIMARY
    );
  const readDecision = (id: string) =>
    metadata.query<Decision>(
      `SELECT id, account_id, subject_id, decision, propagation_targets_json, reason_codes_json, created_at
       FROM external_lifecycle_signal_decisions WHERE tenant_id = ? AND signal_event_id = ? LIMIT 2`,
      [tenantId, id],
      PRIMARY
    );
  const readCompletion = (event: Event) =>
    metadata.queryOne<{
      account_id: string | null;
      subject_id: string | null;
      target_id: string;
      decision: string;
      target_type: string;
      source_event_id: string | null;
      reason_codes_json: string | null;
      created_at: number;
    }>(
      `SELECT account_id, subject_id, target_id, decision, target_type, source_event_id, reason_codes_json, created_at
       FROM provisioning_revocation_events WHERE tenant_id = ? AND id = ?`,
      [tenantId, event.id + ':revocation'],
      PRIMARY
    );
  let proposedOwner: AccountPin | undefined;
  let event = await readEvent();
  if (options.completedEventId !== undefined && (!event || event.id !== options.completedEventId))
    conflict();
  if (!event) {
    const owner = await options.resolveOwner();
    proposedOwner = pin(owner);
    if (
      (input.accountId != null && input.accountId !== owner.accountId) ||
      (input.subjectId != null && input.subjectId !== owner.subjectId)
    )
      throw new LifecycleSignalInputError(
        'Account signal target does not match its canonical owner'
      );
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(eventKey)))
    );
    const id =
      'external_lifecycle_signal_event_' +
      [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const descriptor: Descriptor = {
      version: 1,
      targetType: 'account',
      targetId: input.targetId,
      requestHash,
      owner: pin(owner),
      actorId: options.actorId,
      actorType: options.actorType,
    };
    try {
      await metadata.batch([
        {
          sql: `INSERT INTO external_lifecycle_signal_events (
             id, tenant_id, source_type, source_id, source_event_id, source_timestamp, observed_at,
             binding_version, payload_ref, signal_type, dedupe_key, processing_state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)
           ON CONFLICT DO NOTHING`,
          params: [
            id,
            tenantId,
            input.sourceType,
            input.sourceId,
            input.sourceEventId,
            input.sourceTimestamp ?? null,
            observedAt,
            input.bindingVersion ?? null,
            input.payloadRef ?? null,
            input.signalType,
            dedupeKey,
            observedAt,
            observedAt,
          ],
        },
        {
          sql: `INSERT INTO external_lifecycle_signal_decisions (
             id, tenant_id, signal_event_id, subject_id, account_id, decision,
             propagation_targets_json, reason_codes_json, created_at
           ) SELECT ?, ?, id, ?, ?, 'suspend_account', ?, ?, observed_at
               FROM external_lifecycle_signal_events e
              WHERE e.id = ? AND e.tenant_id = ? AND e.observed_at = ?
                AND NOT EXISTS (SELECT 1 FROM external_lifecycle_signal_decisions d
                                 WHERE d.tenant_id = e.tenant_id AND d.signal_event_id = e.id)`,
          params: [
            id + ':decision',
            tenantId,
            owner.subjectId,
            owner.accountId,
            JSON.stringify([descriptor]),
            JSON.stringify(REASONS),
            id,
            tenantId,
            observedAt,
          ],
        },
      ]);
    } catch (error) {
      // A lost batch response may have committed. Only its primary, complete prepare can resume.
      const committed = await readEvent();
      if (!committed) throw error;
    }
    event = await readEvent();
    if (!event) throw new Error('lifecycle_signal_prepare_not_confirmed');
  }
  const decisions = await readDecision(event.id);
  if (decisions.length !== 1) conflict();
  const decision = decisions[0];
  let descriptor: Descriptor;
  try {
    const value: unknown = JSON.parse(decision.propagation_targets_json ?? 'null');
    if (!Array.isArray(value) || value.length !== 1) conflict();
    descriptor = value[0] as Descriptor;
    if (
      !descriptor ||
      descriptor.version !== 1 ||
      descriptor.targetType !== 'account' ||
      descriptor.targetId !== input.targetId ||
      descriptor.requestHash !== requestHash ||
      descriptor.owner?.accountId !== input.targetId ||
      typeof descriptor.owner?.userId !== 'string' ||
      !descriptor.owner.userId ||
      typeof descriptor.owner.bindingRef !== 'string' ||
      !descriptor.owner.bindingRef ||
      !(descriptor.owner.subjectId === null || typeof descriptor.owner.subjectId === 'string') ||
      !(descriptor.actorId === null || typeof descriptor.actorId === 'string') ||
      !['admin_user', 'machine', 'agent', 'system'].includes(descriptor.actorType)
    )
      conflict();
    requireIdentity(descriptor.owner.identity);
  } catch {
    conflict();
  }
  if (proposedOwner && !equal(proposedOwner, descriptor.owner)) conflict();
  if (
    event.tenant_id !== tenantId ||
    event.source_type !== input.sourceType ||
    event.source_id !== input.sourceId ||
    event.source_event_id !== input.sourceEventId ||
    event.signal_type !== input.signalType ||
    event.source_timestamp !== (input.sourceTimestamp ?? null) ||
    event.binding_version !== (input.bindingVersion ?? null) ||
    event.payload_ref !== (input.payloadRef ?? null) ||
    event.dedupe_key !== dedupeKey ||
    !Number.isSafeInteger(event.observed_at) ||
    event.observed_at < 1 ||
    decision.id !== event.id + ':decision' ||
    decision.account_id !== descriptor.owner.accountId ||
    decision.subject_id !== descriptor.owner.subjectId ||
    decision.decision !== 'suspend_account' ||
    decision.reason_codes_json !== JSON.stringify(REASONS) ||
    decision.created_at !== event.observed_at
  )
    conflict();
  const matchesCompletion = async () => {
    const row = await readCompletion(event);
    return (
      row !== null &&
      row.account_id === descriptor.owner.accountId &&
      row.subject_id === descriptor.owner.subjectId &&
      row.target_id === descriptor.targetId &&
      row.target_type === 'account' &&
      row.decision === 'suspend_account' &&
      row.source_event_id === event.id &&
      row.reason_codes_json === JSON.stringify(REASONS) &&
      row.created_at === event.observed_at
    );
  };
  const result = {
    signalEventId: event.id,
    decision: 'suspend_account' as const,
    reasonCodes: [...REASONS],
  };
  if (event.processing_state === 'processed') {
    if (!(await matchesCompletion())) conflict();
    return { ...result, idempotent: true as const };
  }
  if (options.completedEventId !== undefined || event.processing_state !== 'processing') conflict();
  const owner = await options.resolveOwner();
  if (!equal(pin(owner), descriptor.owner)) conflict();
  const canonicalEvidence = async () => {
    const account = await owner.adapter.queryOne<{
      id: string;
      legacy_user_id: string | null;
      primary_subject_id: string | null;
      lifecycle_state: string;
      status: string | null;
      version: number | null;
      operation: string | null;
    }>(
      `SELECT id, legacy_user_id, primary_subject_id, lifecycle_state,
              json_extract(metadata_json, '$.status') AS status,
              json_extract(metadata_json, '$.lifecycle_version_ms') AS version,
              json_extract(metadata_json, '$.lifecycle_operation_id') AS operation
         FROM identity_accounts WHERE tenant_id = ? AND id = ?`,
      [tenantId, owner.accountId],
      PRIMARY
    );
    if (
      !account ||
      account.legacy_user_id !== owner.userId ||
      account.primary_subject_id !== owner.subjectId ||
      account.lifecycle_state !== 'suspended' ||
      account.status !== 'suspended' ||
      account.version !== event.observed_at ||
      account.operation !== event.id
    )
      return false;
    if (owner.subjectId) {
      const subject = await owner.adapter.queryOne<{ lifecycle_state: string }>(
        'SELECT lifecycle_state FROM identity_subjects WHERE tenant_id = ? AND id = ?',
        [tenantId, owner.subjectId],
        PRIMARY
      );
      if (subject?.lifecycle_state !== 'suspended') return false;
    }
    const state = await readAccountAuthenticationState(options.env, tenantId, owner.userId);
    return (
      state.lifecycle === 'suspended' &&
      state.lifecycleOperationId === event.id &&
      state.lifecycleVersionMs === event.observed_at
    );
  };
  try {
    if (!(await canonicalEvidence())) {
      const ended: string[] = [];
      try {
        if (
          (await transitionAccountLifecycle(options.env, owner.adapter, {
            tenantId,
            userId: owner.userId,
            expectedAccountId: owner.accountId,
            lifecycle: 'suspended',
            status: 'suspended',
            versionMs: event.observed_at,
            operationId: event.id,
            revokeSessions: true,
            onSessionsEnded: (ids) => ended.push(...ids),
          })) !== 'taken'
        )
          conflict();
      } catch (error) {
        // Account commit response loss can be recovered only while its exact result still stands.
        if (!(await canonicalEvidence())) throw error;
      } finally {
        // Identical best-effort logout contract to ordinary suspension, including a later SQL failure.
        try {
          await options.sessionsEnded(event.id, descriptor.owner, descriptor.actorId, ended);
        } catch {
          /* best effort */
        }
      }
    }
    if (!(await canonicalEvidence())) conflict();
    // Refuse a changed placement before recording completion; this is not a cross-store lease.
    if (!equal(pin(await options.resolveOwner()), descriptor.owner)) conflict();
    try {
      await metadata.batch([
        {
          sql: `INSERT INTO provisioning_revocation_events (
             id, tenant_id, subject_id, account_id, source_event_id, target_type, target_id, decision, reason_codes_json, created_at
           ) VALUES (?, ?, ?, ?, ?, 'account', ?, 'suspend_account', ?, ?) ON CONFLICT(id) DO NOTHING`,
          params: [
            event.id + ':revocation',
            tenantId,
            owner.subjectId,
            owner.accountId,
            event.id,
            owner.accountId,
            JSON.stringify(REASONS),
            event.observed_at,
          ],
        },
        {
          sql: `UPDATE external_lifecycle_signal_events SET processing_state = 'processed', updated_at = MAX(updated_at, ?)
                 WHERE tenant_id = ? AND id = ? AND processing_state = 'processing'
                   AND EXISTS (SELECT 1 FROM provisioning_revocation_events r
                     WHERE r.id = ? AND r.tenant_id = ? AND r.account_id = ? AND r.source_event_id = ?
                       AND r.target_type = 'account' AND r.target_id = ? AND r.decision = 'suspend_account'
                       AND r.reason_codes_json = ? AND r.created_at = ? AND r.subject_id IS ?)`,
          params: [
            event.observed_at,
            tenantId,
            event.id,
            event.id + ':revocation',
            tenantId,
            owner.accountId,
            event.id,
            owner.accountId,
            JSON.stringify(REASONS),
            event.observed_at,
            owner.subjectId,
          ],
        },
      ]);
    } catch (error) {
      const committed = await readEvent();
      if (committed?.processing_state !== 'processed' || !(await matchesCompletion())) throw error;
    }
    if ((await readEvent())?.processing_state !== 'processed' || !(await matchesCompletion()))
      conflict();
    try {
      await options.audit(event.id, descriptor, 'success');
    } catch {
      /* existing audit is best effort */
    }
    return result;
  } catch (error) {
    try {
      await options.audit(event.id, descriptor, 'failure');
    } catch {
      /* do not hide the operation error */
    }
    throw error;
  }
}
