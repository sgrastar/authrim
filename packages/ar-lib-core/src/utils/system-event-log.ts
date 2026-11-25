/**
 * The system log: events of the platform itself.
 *
 * A system event is something a Worker, cron, outbox or delivery did, with no administrator and
 * no end user behind it (a dropped webhook queue, a failed connector heartbeat, a metadata
 * refresh). It goes to its own dataset, `runtime.system_events`, not to the end-user event log
 * (`core.event_log`, `createAuditLog`) and not to the admin audit log.
 *
 * The write keeps the contract of `createAuditLog`: the action's audit class decides whether a
 * failure to store it fails the caller (`AuditLogDeliveryError`) or is only logged; the tenant's
 * delivery plan decides retention and the external sinks, which receive the event in the same
 * `event_log` shape as before, with `detailsJson.source_dataset` naming where it is stored.
 *
 * Details are scalars only (counts, times, codes, IDs) and never name a person: a key that looks
 * like one (`user_id`, `email`, `ip_address`, `user_agent`, a URL) is refused, so a caller cannot
 * move personal data into a log that user erasure does not cover.
 */
import type { Env } from '../types/env';
import type { EventCategory, EventSeverity } from '../services/audit/types';
import { SYSTEM_EVENTS_DATASET, type SystemEventLogParams } from '../services/audit/audit-service';
import { createLogger } from './logger';
import {
  AuditLogDeliveryError,
  getUnifiedAuditService,
  isTenantAuditActionFailClosed,
  mapLegacyAuditCategory,
  mapLegacyAuditErrorCode,
  mapLegacyAuditResult,
  requireAuditTenantId,
} from './audit-log';

const log = createLogger().module('SYSTEM_LOG');

export type SystemEventSeverity = 'info' | 'warning' | 'critical';

export type SystemEventDetailValue = string | number | boolean | null;

export interface SystemEventInput {
  tenantId: string;
  /** Where it happened: `authrim/<surface>`, e.g. `authrim/account_webhook_outbox`. */
  source: string;
  /** The event name, as the end-user log named it (`webhook.outbox.dropped`). */
  action: string;
  /** What it was about, when there is one. Never a user. */
  targetType?: string;
  targetId?: string;
  severity?: SystemEventSeverity;
  requestId?: string;
  /**
   * Scalars, or one level of counts by kind (a map from a kind's name, such as an event type,
   * to a number). `result` (`success` / `failure`) and `error_code` are read from here as the
   * end-user log reads them.
   */
  details?: Record<string, SystemEventDetailValue | Record<string, number>>;
  /** A stable ID for a retried write; the same ID with other content is refused by the store. */
  id?: string;
  createdAt?: number;
  requireDurableFanout?: boolean;
}

const SOURCE_PATTERN = /^authrim\/[a-z][a-z0-9_]{0,63}$/u;
const NAME_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const MAX_DETAIL_KEYS = 32;
/**
 * A detail value: a code, an ID, a kind, a time as a number. No spaces, so no free text or
 * name; no `@`, so no address; no `/`, so no URL or path.
 */
const DETAIL_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
/**
 * An IPv4 or IPv6 address (`::ffff:192.0.2.1` included), which is personal data even without a
 * user. Anything made only of hex digits, colons and dots with a colon in it counts.
 */
const IP_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|(?=.*:)[0-9a-f:.]+)$/iu;
/**
 * Keys that name a person or carry a locator, matched on the key normalized without `_`, `-`,
 * `.` and case: `user_id`, `userId` and `user.id` alike.
 */
const REFUSED_DETAIL_KEYS =
  /(userid|accountid|subjectid|principalid|actorid|email|mail|phone|^ip$|^ip[a-z]|ipaddr|clientip|remoteip|sourceip|useragent|url|uri|href|password|secret|token|cookie|authorization|name$|address|^sub$|^dn$|^upn$)/u;
/**
 * A key of a counts-by-kind map is a kind's name (an event type, a reason code); it is refused
 * only when it is, as a whole, the name of a personal field. `account.email.changed` is an
 * event type; `email` or `user.id` is not.
 */
const REFUSED_KIND_KEYS =
  /^(userid|accountid|subjectid|principalid|actorid|email|mail|phone|ip|ipaddress|useragent|url|uri|href|password|secret|token|cookie|authorization|name|address|sub|dn|upn)$/u;
/** Keys the writer sets itself; a caller may not pretend to be another dataset or target. */
const RESERVED_DETAIL_KEYS = new Set([
  'source',
  'sourcedataset',
  'origin',
  'resourcetype',
  'resourceid',
  'tenantid',
  'anonymizeduserid',
]);

function normalizeKey(key: string): string {
  return key.replace(/[_\-.\s]/gu, '').toLowerCase();
}

function invalid(reason: string): never {
  throw new Error(`system_event_${reason}`);
}

function checkKey(key: string, path: string, kind = false): void {
  if (!NAME_PATTERN.test(key)) invalid(`detail_key_invalid:${path}`);
  if (IP_PATTERN.test(key)) invalid(`detail_key_refused:${path}`);
  const normalized = normalizeKey(key);
  if (RESERVED_DETAIL_KEYS.has(normalized)) invalid(`detail_key_reserved:${path}`);
  if ((kind ? REFUSED_KIND_KEYS : REFUSED_DETAIL_KEYS).test(normalized))
    invalid(`detail_key_refused:${path}`);
}

/** Whether a string may be a detail value: a code or an ID, never an address or free text. */
export function isSystemEventDetailValue(value: string): boolean {
  return DETAIL_VALUE_PATTERN.test(value) && !IP_PATTERN.test(value);
}

function checkScalar(value: unknown, path: string): asserts value is SystemEventDetailValue {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`detail_invalid:${path}`);
    return;
  }
  if (typeof value === 'string') {
    if (!isSystemEventDetailValue(value)) invalid(`detail_invalid:${path}`);
    return;
  }
  invalid(`detail_invalid:${path}`);
}

/**
 * The details a system event may carry, or a thrown `system_event_detail_*` error. Top-level keys
 * are snake_case names. Values are codes, IDs, kinds, numbers and booleans: nothing that reads
 * as a name, an address or a locator, because this log has no subject to erase by. A nested
 * object is counts by kind: its keys are kinds' names (event types, reason codes), its values
 * numbers, so it can never carry a value about a person.
 */
export function checkSystemEventDetails(
  details: Record<string, unknown> | undefined
): Record<string, SystemEventDetailValue | Record<string, number>> {
  if (details === undefined) return {};
  if (!details || typeof details !== 'object' || Array.isArray(details)) invalid('details_invalid');
  const entries = Object.entries(details);
  if (entries.length > MAX_DETAIL_KEYS) invalid('details_too_many');
  const out: Record<string, SystemEventDetailValue | Record<string, number>> = {};
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) invalid(`detail_key_invalid:${key}`);
    checkKey(key, key);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = Object.entries(value as Record<string, unknown>);
      if (nested.length > MAX_DETAIL_KEYS) invalid(`detail_too_many:${key}`);
      const map: Record<string, number> = {};
      for (const [innerKey, innerValue] of nested) {
        checkKey(innerKey, `${key}.${innerKey}`, true);
        if (typeof innerValue !== 'number' || !Number.isFinite(innerValue))
          invalid(`detail_invalid:${key}.${innerKey}`);
        map[innerKey] = innerValue;
      }
      out[key] = map;
      continue;
    }
    checkScalar(value, key);
    out[key] = value;
  }
  return out;
}

const SEVERITY: Record<SystemEventSeverity, EventSeverity> = {
  info: 'info',
  warning: 'warn',
  critical: 'critical',
};

/**
 * Records a system event. Throws `AuditLogDeliveryError` when the action's audit class is
 * fail-closed (the default for an unclassified action, and for every action under a tenant
 * profile that fails all actions closed) or `requireDurableFanout` is set and the event could
 * not be stored; otherwise a storage failure is logged and the caller goes on. Input errors
 * (`system_event_*`) always throw: they are programming errors, not delivery failures.
 */
export async function logSystemEvent(env: Env, input: SystemEventInput): Promise<void> {
  const tenantId = requireAuditTenantId(input.tenantId, input.action);
  if (!tenantId) return;
  if (!SOURCE_PATTERN.test(input.source)) invalid('source_invalid');
  if (!NAME_PATTERN.test(input.action)) invalid('action_invalid');
  if (input.targetType !== undefined && !NAME_PATTERN.test(input.targetType))
    invalid('target_type_invalid');
  if (input.targetId !== undefined && !ID_PATTERN.test(input.targetId))
    invalid('target_id_invalid');
  if (input.requestId !== undefined && !ID_PATTERN.test(input.requestId))
    invalid('request_id_invalid');
  if (input.id !== undefined && !ID_PATTERN.test(input.id)) invalid('id_invalid');
  const createdAt = input.createdAt ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) invalid('created_at_invalid');
  const details = checkSystemEventDetails(input.details);
  const severity = input.severity ?? 'info';
  const metadata = details as Record<string, unknown>;
  const result = mapLegacyAuditResult(input.action, metadata);
  const errorCode = mapLegacyAuditErrorCode(result, metadata);
  const eventCategory: EventCategory = mapLegacyAuditCategory(input.action, input.targetType ?? '');

  if (env.AUDIT_RUNTIME_PORTS) {
    // A deployment-owned audit store (AWS) takes one shape and has no dataset of its own for
    // system events: the row is marked by its metadata instead.
    try {
      await env.AUDIT_RUNTIME_PORTS.append({
        id: input.id ?? crypto.randomUUID(),
        tenantId,
        userId: 'system',
        action: input.action,
        resource: input.targetType ?? 'system',
        resourceId: input.targetId ?? '',
        ipAddress: 'system',
        userAgent: input.source,
        metadata: JSON.stringify({ ...details, source_dataset: SYSTEM_EVENTS_DATASET }),
        severity,
        createdAt,
        ...(input.requireDurableFanout ? { requireDurableFanout: true } : {}),
      });
    } catch {
      throw new AuditLogDeliveryError('audit_log_runtime_write_failed', input.action, tenantId);
    }
    return;
  }

  const failClosed =
    input.requireDurableFanout === true ||
    (await isTenantAuditActionFailClosed(env, tenantId, input.action));
  const params: SystemEventLogParams = {
    ...(input.id ? { id: input.id } : {}),
    createdAt,
    source: input.source,
    eventType: input.action,
    eventCategory,
    result,
    severity: SEVERITY[severity],
    ...(errorCode ? { errorCode } : {}),
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    details,
    ...(input.requireDurableFanout ? { requireDurableFanout: true } : {}),
  };
  try {
    await getUnifiedAuditService(env).logSystemEvent(tenantId, params);
  } catch (error) {
    log.error('Failed to persist system event', { action: input.action }, error as Error);
    if (failClosed) {
      throw new AuditLogDeliveryError('audit_log_write_failed', input.action, tenantId);
    }
  }
}
