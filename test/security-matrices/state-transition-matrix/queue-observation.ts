/**
 * Queue-delivery shared helpers: build queue envs (healthy/missing/throwing bindings),
 * construct message bodies per matrix row, run the REAL production consumers with
 * attempt/delivery semantics actually executed (Message.attempts reflects the attempt
 * axis; duplicate delivery runs the consumer TWICE with fresh Message objects sharing
 * the same durable backing state), and build/compare observations.
 *
 * This helper module is intentionally not collected as a test.
 */
import { createSecurityMatrixEnv, type SecurityMatrixEnvKit } from '../fixtures/env';
import { CallLedger } from '../fixtures/call-ledger';
import { advanceFrozenClockByMs } from '../fixtures/deterministic-clock';
import {
  processAuditQueue,
  processDLQQueue,
  processLoggingDeliveryQueue,
} from '../../../packages/ar-lib-core/src/services/audit/queue-consumer';
import {
  decideQueueAudit,
  decideQueueDlq,
  decideQueueLog,
  type QueueDecision,
  type StateCase,
} from './cases';
import {
  D1DatabaseLike,
  MessageFake,
  createCapturingLogger,
  effectiveMessageDispositions,
  messageCallCounts,
} from './harness';
import type { MessageBatch, Message } from '@cloudflare/workers-types';

export const FROZEN_NOW = 1700000000;

/**
 * Fixed 256-bit hex credential canary per case. It is installed as the queue
 * encryption-root credential, never as message data, and therefore must not surface
 * in logs, D1 params, R2 bodies/metadata/keys, DLQ archives, or error surfaces.
 */
export function queueCanarySecret(entryId: string): string {
  let hash = 2166136261;
  for (const character of entryId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${'a'.repeat(56)}${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function throwingD1(): unknown {
  return {
    prepare: () => {
      throw new Error('d1 binding failed deterministically');
    },
    batch: async () => {
      throw new Error('d1 binding failed deterministically');
    },
  };
}

export function makeQueueEnv(
  kit: SecurityMatrixEnvKit,
  entry: StateCase,
  ledger: CallLedger,
  canary: string
): { env: unknown; logger: ReturnType<typeof createCapturingLogger> } {
  const d = entry.dimensions;
  const env = kit.env as unknown as Record<string, unknown>;
  const bindingState = String(d.bindingState);
  env.DB = new D1DatabaseLike(kit.coreAdapter, true, ledger) as unknown as typeof env.DB;
  env.DB_PII = new D1DatabaseLike(kit.piiAdapter, true, ledger) as unknown as typeof env.DB_PII;
  env.DB_ADMIN = new D1DatabaseLike(
    kit.adminAdapter,
    true,
    ledger
  ) as unknown as typeof env.DB_ADMIN;
  env.OBJECT_ENCRYPTION_ROOT_KEY = canary;
  env.OBJECT_ENCRYPTION_KEY_VERSION = '1';
  // The archive/diagnostic/sensitive buckets record put metadata so the secret-leak
  // oracle can scan R2 keys, customMetadata, and bodies.
  env.AUDIT_ARCHIVE = wrapRecordingBucket(kit.env.AUDIT_ARCHIVE, ledger, 'AUDIT_ARCHIVE', canary);
  env.DIAGNOSTIC_LOGS = wrapRecordingBucket(
    kit.env.DIAGNOSTIC_LOGS,
    ledger,
    'DIAGNOSTIC_LOGS',
    canary
  );
  env.SENSITIVE_DETAILS = wrapRecordingBucket(
    kit.env.SENSITIVE_DETAILS,
    ledger,
    'SENSITIVE_DETAILS',
    canary
  );
  if (bindingState === 'missing') {
    env.DB = undefined;
    env.DB_PII = undefined;
    env.DB_ADMIN = undefined;
    env.AUDIT_ARCHIVE = undefined;
    env.DIAGNOSTIC_LOGS = undefined;
    env.SENSITIVE_DETAILS = undefined;
  }
  const dlqArchive = String(d.dlqArchive);
  if (dlqArchive === 'missing') {
    env.AUDIT_ARCHIVE = undefined;
  }
  if (bindingState === 'throws') {
    const throwingBucket = {
      put: async () => {
        throw new Error('r2 put failed deterministically');
      },
      get: async () => null,
      delete: async () => undefined,
      head: async () => null,
      list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
      createMultipartUpload: async () => {
        throw new Error('unsupported');
      },
      resumeMultipartUpload: async () => {
        throw new Error('unsupported');
      },
    };
    env.DB = throwingD1();
    env.DB_PII = throwingD1();
    env.DB_ADMIN = throwingD1();
    env.AUDIT_ARCHIVE = throwingBucket;
    env.DIAGNOSTIC_LOGS = throwingBucket;
    env.SENSITIVE_DETAILS = throwingBucket;
  }
  if (dlqArchive === 'throws') {
    const throwingBucket = {
      put: async () => {
        throw new Error('r2 put failed deterministically');
      },
      get: async () => null,
      delete: async () => undefined,
      head: async () => null,
      list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
      createMultipartUpload: async () => {
        throw new Error('unsupported');
      },
      resumeMultipartUpload: async () => {
        throw new Error('unsupported');
      },
    };
    env.AUDIT_ARCHIVE = throwingBucket;
  }
  const captured = createCapturingLogger(ledger);
  return { env, logger: captured };
}

/**
 * Wrap a bucket so every put records its key, customMetadata, and a safely truncated
 * body into the ledger (kind 'event', target 'r2meta:<label>:<key>') for the
 * secret-leak oracle, while delegating to the real fake bucket.
 */
function wrapRecordingBucket(
  bucket: unknown,
  ledger: CallLedger,
  label: string,
  canary: string
): unknown {
  const delegate = bucket as Record<string, unknown> | undefined;
  if (!delegate || typeof delegate.put !== 'function') {
    return bucket;
  }
  const put = delegate.put as (key: string, value: unknown, options?: unknown) => Promise<unknown>;
  const wrapper = Object.create(Object.getPrototypeOf(delegate)) as Record<string, unknown>;
  for (const key of Object.keys(delegate)) {
    wrapper[key] = (delegate as Record<string, unknown>)[key];
  }
  wrapper.put = async (key: string, value: unknown, options?: unknown): Promise<unknown> => {
    const optionsRecord = (options ?? {}) as Record<string, unknown>;
    const metadata = optionsRecord.customMetadata ?? null;
    let bodySnippet: string | null = null;
    let fullBody: string | null = null;
    try {
      const bodyText = typeof value === 'string' ? value : JSON.stringify(value);
      fullBody = bodyText;
      bodySnippet = bodyText ? bodyText.slice(0, 300) : null;
    } catch {
      bodySnippet = null;
    }
    // The canary check runs over the FULL body so truncation can never hide a leak.
    const canaryInBody = fullBody !== null && fullBody.includes(canary);
    const canaryInMetadata = JSON.stringify(metadata).includes(canary);
    ledger.record('event', `r2meta:${label}:${key}`, {
      key,
      customMetadata: metadata,
      bodySnippet,
      canaryPresent: canaryInBody || canaryInMetadata,
    });
    return put.call(delegate, key, value, options);
  };
  return wrapper;
}

export function eventLogEntry(
  id: string,
  canary: string,
  tenantId = 'default'
): Record<string, unknown> {
  return {
    id,
    tenantId,
    eventType: 'login',
    eventCategory: 'authn',
    result: 'success',
    severity: 'info',
    createdAt: 1700000000,
  };
}

export function auditMessageBody(
  entry: StateCase,
  id: string,
  canary: string
): Record<string, unknown> {
  const d = entry.dimensions;
  const payloadFamily = String(d.payloadFamily);
  const tenant = String(d.tenant);
  const tenantId = tenant === 'foreign' ? 'foreign' : 'default';
  const body: Record<string, unknown> = {
    type: payloadFamily === 'pii-log' ? 'pii_log' : 'event_log',
    tenantId,
    timestamp: 1700000000,
    entries: [eventLogEntry(id, canary, tenantId)],
  };
  if (payloadFamily === 'unknown-audit') {
    body.type = 'bogus_unknown_type';
  }
  if (payloadFamily === 'fanout') {
    body.fanout = {
      auditProfileId: 'builtin:audit:standard',
      archives: [{ type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' }],
      sinks: [],
      archiveFailureMode: 'gate_cleanup',
      sinkFailureMode: 'best_effort',
    };
  }
  return body;
}

export function loggingMessageBody(
  entry: StateCase,
  id: string,
  canary: string
): Record<string, unknown> {
  const d = entry.dimensions;
  const payloadFamily = String(d.payloadFamily);
  const schema = String(d.schema);
  const lane = String(d.lane) === 'fallback' ? 'default' : String(d.lane);
  const tenant = String(d.tenant);
  const tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
  const base = {
    payload_type:
      payloadFamily === 'chunk-write'
        ? 'chunk_write'
        : payloadFamily === 'delivery-fanout'
          ? 'delivery_fanout'
          : payloadFamily === 'http-sink-batch'
            ? 'http_sink_batch'
            : payloadFamily === 'dlq-replay'
              ? 'dlq_replay'
              : 'rewrap_chunk',
    schema_version: schema === 'future' ? 99 : 1,
    payload_id: `qpl_${id}`,
    tenant_key: tenantKey,
    lane,
    created_at: 1700000000,
  };
  if (payloadFamily === 'chunk-write') {
    return {
      ...base,
      log_type: 'audit',
      plane: 'archive',
      records: [eventLogEntry(id, canary)],
    };
  }
  if (payloadFamily === 'delivery-fanout' || payloadFamily === 'http-sink-batch') {
    return {
      ...base,
      catalog_id: `catalog-${id}`,
      object_key: `logs/v1/audit/${id}.json`,
      destination_id: `dest-${id}`,
      log_type: 'audit',
      plane: 'archive',
      record_count: 1,
      endpoint_url: 'https://webhook.invalid.example/hooks',
      batch_id: `batch-${id}`,
    };
  }
  if (payloadFamily === 'dlq-replay') {
    return { ...base, dlq_item_id: `dlq-${id}`, requested_by: 'matrix-test' };
  }
  return { ...base, rewrap_job_id: `rewrap-${id}`, object_catalog_id: `catalog-${id}` };
}

function consumerOf(entry: StateCase): 'audit' | 'dlq' | 'logging-delivery' {
  if (entry.matrix.startsWith('Q-L')) return 'logging-delivery';
  if (entry.matrix.startsWith('Q-D')) return 'dlq';
  return 'audit';
}

export function messageBody(entry: StateCase, id: string, canary: string): Record<string, unknown> {
  if (consumerOf(entry) === 'logging-delivery') {
    return loggingMessageBody(entry, id, canary);
  }
  return auditMessageBody(entry, id, canary);
}

export function batchIds(entry: StateCase): string[] {
  return String(entry.dimensions.batchComposition) === 'all-success' ? ['m1'] : ['m1', 'm2'];
}

function attemptsFor(entry: StateCase): number {
  const attempt = String(entry.dimensions.attempt);
  return attempt === 'retry' ? 2 : attempt === 'terminal' ? 5 : 1;
}

/**
 * Run one delivery of the row's batch through the REAL consumer. Fresh Message objects
 * with the row's attempts value; every delivery creates new messages but shares the
 * same D1/R2/notification backing state.
 */
async function deliverOnce(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase,
  env: unknown,
  logger: ReturnType<typeof createCapturingLogger>,
  canary: string,
  attempts: number,
  messages: MessageFake<Record<string, unknown>>[]
): Promise<void> {
  const consumer = consumerOf(entry);
  const batch = {
    queue: consumer,
    messages: messages as unknown as Message<unknown>[],
  } as unknown as MessageBatch<unknown>;
  void attempts;
  void canary;
  if (consumer === 'audit') {
    await processAuditQueue(batch as never, env as never, logger.logger as never);
  } else if (consumer === 'dlq') {
    await processDLQQueue(batch as never, env as never, logger.logger as never);
  } else {
    await processLoggingDeliveryQueue(batch as never, env as never, logger.logger as never);
  }
}

export async function runQueueRow(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase,
  options?: {
    loggerCapture?: boolean;
    messageIds?: string[];
    messageOrder?: 'forward' | 'reverse';
  }
): Promise<{
  messages: MessageFake<Record<string, unknown>>[];
  logger: ReturnType<typeof createCapturingLogger>;
}> {
  const d = entry.dimensions;
  const consumer = consumerOf(entry);
  const batchComposition = String(d.batchComposition);
  const delivery = String(d.delivery);
  const attempts = attemptsFor(entry);
  const canary = queueCanarySecret(entry.id);
  const ids = options?.messageIds ?? batchIds(entry);
  const allMessages: MessageFake<Record<string, unknown>>[] = [];
  const { env, logger } = makeQueueEnv(kit, entry, ledger, canary);

  const buildMessages = (): MessageFake<Record<string, unknown>>[] => {
    const messages = ids.map((id, index) => {
      if (batchComposition === 'mixed' && index === 1) {
        // The second message of a mixed batch is a deliberately failing message:
        // an unknown audit type for the audit consumer, a malformed envelope for the
        // logging-delivery consumer.
        const failingBody =
          consumer === 'audit'
            ? { type: 'bogus_unknown_type', tenantId: 'default', timestamp: 1, entries: [] }
            : { foo: 'not-a-valid-envelope' };
        return new MessageFake({ id, body: failingBody, attempts }, ledger);
      }
      return new MessageFake({ id, body: messageBody(entry, id, canary), attempts }, ledger);
    });
    return options?.messageOrder === 'reverse' ? messages.reverse() : messages;
  };

  const first = buildMessages();
  allMessages.push(...first);
  await deliverOnce(kit, ledger, entry, env, logger, canary, attempts, first);
  if (delivery === 'duplicate') {
    // Redelivery: fresh Message objects, the SAME durable backing state, at a later
    // wall-clock time (real redelivery semantics). attempts increments like Cloudflare.
    advanceFrozenClockByMs(60_000);
    const second = buildMessages();
    for (const message of second) {
      message.attempts = attempts + 1;
    }
    allMessages.push(...second);
    await deliverOnce(kit, ledger, entry, env, logger, canary, attempts + 1, second);
  }
  void options;
  return { messages: allMessages, logger };
}

function d1InsertIdentity(sql: string, params: unknown[]): string | null {
  const table = /INSERT INTO (\w+)/.exec(sql)?.[1];
  if (!table) return null;
  if (table === 'log_chunk_record_index') {
    return `${table}:${JSON.stringify([params[1], params[2], params[3], params[0]])}`;
  }
  if (table === 'logging_delivery_event_aggregates') {
    return `${table}:${JSON.stringify([
      params[0],
      params[2],
      params[3],
      params[4],
      params[5],
      params[6],
      params[7],
      params[8],
    ])}`;
  }
  return `${table}:${JSON.stringify(params[0])}`;
}

/**
 * Count durable write CALLS (every d1.execute INSERT/UPDATE + every r2.put) and UNIQUE
 * durable effects (distinct INSERT identities + distinct R2 object keys). The D1 params
 * are captured by the params-recording D1DatabaseLike so INSERT identities include the
 * bound values: an idempotent event_log INSERT keeps the same identity across
 * redeliveries, while a clock-derived chunk/dlq id yields a new identity each time.
 */
function countDurableEffects(ledger: CallLedger): { writeCalls: number; uniqueEffects: number } {
  const identities = new Set<string>();
  let writeCalls = 0;
  for (const entry of ledger.all()) {
    if (entry.kind === 'd1.execute') {
      const isParams = entry.target.startsWith('params:');
      const sql = isParams ? entry.target.slice(7).trimStart() : entry.target;
      if (!isParams && (sql.includes('INSERT') || sql.includes('UPDATE'))) {
        writeCalls += 1;
      }
      if (
        isParams &&
        sql.includes('INSERT') &&
        Array.isArray((entry.detail as { params?: unknown[] })?.params)
      ) {
        const identity = d1InsertIdentity(sql, (entry.detail as { params: unknown[] }).params);
        if (identity) identities.add(identity);
      }
    }
    if (entry.kind === 'r2.put') {
      writeCalls += 1;
      identities.add(`r2:${entry.target}`);
    }
  }
  return { writeCalls, uniqueEffects: identities.size };
}

export async function buildQueueObservation(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase,
  ids: string[],
  logger: ReturnType<typeof createCapturingLogger>
): Promise<QueueDecision> {
  const effective = effectiveMessageDispositions(ledger, ids);
  const calls = messageCallCounts(ledger, ids);
  const { writeCalls, uniqueEffects } = countDurableEffects(ledger);
  const decision: QueueDecision = {
    acked: ids.filter((id) => effective[id].acked),
    retried: ids.filter((id) => effective[id].retried),
    ackCalls: Object.fromEntries(ids.map((id) => [id, calls[id].ackCalls])),
    retryCalls: Object.fromEntries(ids.map((id) => [id, calls[id].retryCalls])),
    effective: Object.fromEntries(ids.map((id) => [id, calls[id].effective ?? 'retry'])),
    writeCalls,
    uniqueEffects,
    dlqSaved: ledger
      .all()
      .some(
        (e) =>
          e.kind === 'r2.put' && (e.target.includes('dlq/') || e.target.includes('/unsupported/'))
      ),
    tenantKey: (() => {
      const serialized = ledger
        .all()
        .filter((e) => e.kind === 'r2.put')
        .map((e) => e.target)
        .join('\n');
      const explicit = serialized.match(/tenant_key=([A-Za-z0-9_-]+)/);
      if (explicit) {
        if (explicit[1].startsWith('t_N6juwc4ZaH0TL')) return 'default';
        if (explicit[1].startsWith('t_ZWdxkF4e9zH2XNCg2fsGEjg4ChoBLmq9')) return 'foreign';
        return explicit[1];
      }
      if (serialized.includes('ZWdxkF4e9zH2XNCg2fsGEjg4ChoBLmq9')) return 'foreign';
      if (serialized.includes('N6juwc4ZaH0TL')) return 'default';
      // event_log / pii_log INSERTs carry the tenantId as the second bound param.
      for (const entry of ledger.all()) {
        if (
          entry.kind === 'd1.execute' &&
          entry.target.includes('INSERT INTO event_log') &&
          entry.detail
        ) {
          const params = (entry.detail as { params?: unknown[] }).params ?? [];
          return String(params[1]);
        }
        if (
          entry.kind === 'd1.execute' &&
          entry.target.includes('INSERT INTO pii_log') &&
          entry.detail
        ) {
          const params = (entry.detail as { params?: unknown[] }).params ?? [];
          return String(params[1]);
        }
        // logging_dlq_items / logging_delivery_events / aggregates carry the derived
        // tenant key as a later bound param.
        if (
          entry.kind === 'd1.execute' &&
          entry.target.startsWith('params:') &&
          (entry.target.includes('logging_dlq_items') ||
            entry.target.includes('logging_delivery_events') ||
            entry.target.includes('log_object_catalog') ||
            entry.target.includes('logging_delivery_event_aggregates')) &&
          entry.detail
        ) {
          const params = (entry.detail as { params?: unknown[] }).params ?? [];
          const derived = params.find(
            (p) =>
              typeof p === 'string' &&
              (p.startsWith('t_N6juwc4ZaH0TL') ||
                p.startsWith('t_ZWdxkF4e9zH2XNCg2fsGEjg4ChoBLmq9'))
          );
          if (derived && typeof derived === 'string') {
            return derived.startsWith('t_N6juwc4ZaH0TL') ? 'default' : 'foreign';
          }
          // chunk-write catalog carries the RAW tenant key (default/foreign).
          const raw = params.find((p) => p === 'default' || p === 'foreign');
          if (raw && entry.target.includes('log_object_catalog')) {
            return raw;
          }
        }
      }
      return '';
    })(),
    attemptsDelivered: attemptsFor(entry),
    secretLeak: false,
  };
  decision.secretLeak = scanForSecretLeak(ledger, logger, queueCanarySecret(entry.id));
  void kit;
  return decision;
}

/**
 * Secret-leak oracle: a fixed canary credential is installed as the encryption-root
 * binding and is deliberately absent from the input message. It must never surface in:
 * - the captured production logger messages and structured fields
 * - D1 prepared-statement params (safe-serializable subset)
 * - R2 put keys or customMetadata
 * - R2 put bodies of DERIVED objects (chunk records) — these are produced from the
 *   business records, so a credential placeholder must not propagate into them
 * - the queue payload/delivery metadata or any error surface
 * The canary is an environment credential and is never part of the input message, so
 * there is no DLQ exception: its appearance on any inspected surface is a leak.
 */
export function scanForSecretLeak(
  ledger: CallLedger,
  logger: ReturnType<typeof createCapturingLogger>,
  canary: string
): boolean {
  const surfaces: string[] = [];
  for (const entry of ledger.all()) {
    if (entry.kind === 'audit' && entry.target.startsWith('log:')) {
      surfaces.push(`log:${entry.target}:${JSON.stringify(entry.detail ?? {})}`);
    }
    if (entry.target.startsWith('params:')) {
      surfaces.push(`d1:${entry.target}:${JSON.stringify(entry.detail ?? {})}`);
    }
    if (entry.kind === 'event' && entry.target.startsWith('r2meta:')) {
      const key = String((entry.detail as { key?: unknown } | undefined)?.key ?? '');
      const canaryPresent =
        (entry.detail as { canaryPresent?: unknown } | undefined)?.canaryPresent === true;
      if (canaryPresent) {
        return true;
      }
      surfaces.push(`r2:${entry.target}:${JSON.stringify(entry.detail ?? {})}`);
    }
  }
  for (const logEntry of logger.entries) {
    surfaces.push(`logger:${logEntry.message}:${JSON.stringify(logEntry.context)}`);
  }
  return surfaces.some((surface) => surface.includes(canary));
}

export function queueDecisionFor(entry: StateCase): QueueDecision {
  const consumer = consumerOf(entry);
  if (consumer === 'audit') {
    return decideQueueAudit(entry.dimensions as never);
  }
  if (consumer === 'dlq') {
    return decideQueueDlq(entry.dimensions as never);
  }
  return decideQueueLog(entry.dimensions as never);
}

export function queueMutationCandidate(entry: StateCase, mutationId: string): QueueDecision {
  const base = queueDecisionFor(entry);
  const ids = base.acked.length > 0 ? base.acked : base.retried.length > 0 ? base.retried : ['m1'];
  switch (mutationId) {
    case 'queue:retry-entire-mixed-batch': {
      // A successful message in a mixed batch would be retried too.
      const retried = [...base.retried, ...base.acked].filter((v, i, a) => a.indexOf(v) === i);
      if (base.acked.length === 0) {
        return { ...base, writeCalls: base.writeCalls + 1 };
      }
      return { ...base, acked: [], retried };
    }
    case 'queue:ack-unsupported-schema-before-durable-dlq':
      // An unsupported schema would be acked before the durable DLQ save.
      return { ...base, acked: ids, retried: [], dlqSaved: false, writeCalls: 0, uniqueEffects: 0 };
    case 'queue:ack-transient-failure':
      // A transient failure would be acked (or a success would be retried).
      if (base.retried.length > 0) {
        return {
          ...base,
          acked: base.retried,
          retried: [],
          writeCalls: Math.max(1, base.writeCalls),
        };
      }
      return { ...base, acked: [], retried: base.acked };
    case 'queue:duplicate-durable-effect-on-redelivery':
      // A redelivery would duplicate durable effects.
      return { ...base, uniqueEffects: base.uniqueEffects > 0 ? base.uniqueEffects * 2 : 1 };
    default:
      throw new Error(`Unknown queue mutation ${mutationId}`);
  }
}

export { createSecurityMatrixEnv };

export type QueueObservationDomain =
  | 'acked'
  | 'retried'
  | 'dlqSaved'
  | 'writeCalls'
  | 'uniqueEffects'
  | 'tenantKey'
  | 'secretLeak';

export function corruptQueueObservationDomain(
  observation: QueueDecision,
  domain: QueueObservationDomain
): QueueDecision {
  const corrupted = { ...observation };
  switch (domain) {
    case 'acked':
      corrupted.acked = corrupted.acked.length > 0 ? [] : corrupted.retried;
      break;
    case 'retried':
      corrupted.retried = corrupted.retried.length > 0 ? [] : corrupted.acked;
      break;
    case 'dlqSaved':
      corrupted.dlqSaved = !corrupted.dlqSaved;
      break;
    case 'writeCalls':
      corrupted.writeCalls = corrupted.writeCalls + 1;
      break;
    case 'uniqueEffects':
      corrupted.uniqueEffects = corrupted.uniqueEffects + 1;
      break;
    case 'tenantKey':
      corrupted.tenantKey =
        corrupted.tenantKey === 'default'
          ? 'foreign'
          : corrupted.tenantKey === 'foreign'
            ? 'default'
            : 'default';
      break;
    case 'secretLeak':
      corrupted.secretLeak = !corrupted.secretLeak;
      break;
    default:
      throw new Error(`Unknown queue domain ${domain}`);
  }
  return corrupted;
}
