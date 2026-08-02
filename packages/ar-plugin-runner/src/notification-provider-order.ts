import type { D1Database, D1DatabaseSession, D1Result } from '@cloudflare/workers-types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const MAX_PROVIDERS = 8;

export interface ReplaceNotificationProviderOrderInput {
  operationId: string;
  tenantId: string;
  channel: 'email' | 'sms' | 'push';
  expectedConfigVersion: number;
  installationIds: string[];
}

export interface NotificationProviderOrder {
  tenantId: string;
  channel: 'email' | 'sms' | 'push';
  configVersion: number;
  state: 'enabled' | 'disabled';
  installationIds: string[];
}

interface RouteSetRow {
  tenant_id: string;
  channel: string;
  config_version: number | string;
  state: string;
  last_operation_id: string;
  order_fingerprint: string;
  created_at: number | string;
  updated_at: number | string;
}

interface RouteEntryRow {
  installation_id: string;
  priority: number | string;
  installation_tenant_id: string | null;
  installation_state: string | null;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_notification_provider_order_d1_session_required');
  }
  return db.withSession('first-primary');
}

function integer(value: number | string, minimum: number, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
}

function validate(input: unknown): asserts input is ReplaceNotificationProviderOrderInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('plugin_notification_provider_order_input_invalid');
  }
  const value = input as Partial<ReplaceNotificationProviderOrderInput>;
  if (
    Object.keys(input).sort().join(',') !==
      ['channel', 'expectedConfigVersion', 'installationIds', 'operationId', 'tenantId']
        .sort()
        .join(',') ||
    typeof value.operationId !== 'string' ||
    !SAFE_ID.test(value.operationId) ||
    typeof value.tenantId !== 'string' ||
    !SAFE_ID.test(value.tenantId) ||
    !['email', 'sms', 'push'].includes(String(value.channel)) ||
    !Number.isSafeInteger(value.expectedConfigVersion) ||
    (value.expectedConfigVersion as number) < 0 ||
    !Array.isArray(value.installationIds) ||
    value.installationIds.length > MAX_PROVIDERS ||
    value.installationIds.some((installationId) =>
      typeof installationId !== 'string' ? true : !SAFE_ID.test(installationId)
    ) ||
    new Set(value.installationIds).size !== value.installationIds.length
  ) {
    throw new Error('plugin_notification_provider_order_input_invalid');
  }
}

async function fingerprint(input: ReplaceNotificationProviderOrderInput): Promise<string> {
  const canonical = JSON.stringify([
    'authrim-notification-provider-order-v1',
    input.tenantId,
    input.channel,
    input.installationIds,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertBatch(results: D1Result<unknown>[], expected: number): void {
  if (
    results.length !== expected ||
    results.some(
      (result) =>
        result.success !== true || result.error !== undefined || (result.meta.changes ?? 0) !== 1
    )
  ) {
    throw new Error('plugin_notification_provider_order_batch_failed');
  }
}

async function load(
  session: D1DatabaseSession,
  tenantId: string,
  channel: ReplaceNotificationProviderOrderInput['channel']
): Promise<{ route: RouteSetRow | null; entries: RouteEntryRow[] }> {
  const [route, entryResult] = await Promise.all([
    session
      .prepare(
        `SELECT tenant_id, channel, config_version, state, last_operation_id,
                order_fingerprint, created_at, updated_at
           FROM plugin_runner_notification_route_sets
          WHERE tenant_id = ? AND channel = ?`
      )
      .bind(tenantId, channel)
      .first<RouteSetRow>(),
    session
      .prepare(
        `SELECT entry.installation_id, entry.priority,
                installation.tenant_id AS installation_tenant_id,
                installation.state AS installation_state
           FROM plugin_runner_notification_route_entries entry
           LEFT JOIN plugin_runner_installations installation
             ON installation.installation_id = entry.installation_id
          WHERE entry.tenant_id = ? AND entry.channel = ?
          ORDER BY entry.priority ASC`
      )
      .bind(tenantId, channel)
      .all<RouteEntryRow>(),
  ]);
  if (entryResult.success !== true || entryResult.error !== undefined) {
    throw new Error('plugin_notification_provider_order_read_failed');
  }
  return { route, entries: entryResult.results };
}

function reflect(
  loaded: Awaited<ReturnType<typeof load>>,
  expected?: { input: ReplaceNotificationProviderOrderInput; orderFingerprint: string }
): NotificationProviderOrder | null {
  const { route, entries } = loaded;
  if (!route) {
    if (entries.length > 0)
      throw new Error('plugin_notification_provider_order_reflection_invalid');
    return null;
  }
  const configVersion = integer(
    route.config_version,
    1,
    'plugin_notification_provider_order_reflection_invalid'
  );
  if (
    route.tenant_id !== (expected?.input.tenantId ?? route.tenant_id) ||
    !['email', 'sms', 'push'].includes(route.channel) ||
    (route.state !== 'enabled' && route.state !== 'disabled') ||
    !SAFE_ID.test(route.last_operation_id) ||
    !/^[0-9a-f]{64}$/u.test(route.order_fingerprint) ||
    integer(route.created_at, 1, 'plugin_notification_provider_order_reflection_invalid') < 1 ||
    integer(route.updated_at, 1, 'plugin_notification_provider_order_reflection_invalid') < 1 ||
    entries.length > MAX_PROVIDERS ||
    entries.some(
      (entry, index) =>
        integer(entry.priority, 0, 'plugin_notification_provider_order_reflection_invalid') !==
          index ||
        !SAFE_ID.test(entry.installation_id) ||
        entry.installation_tenant_id !== route.tenant_id ||
        entry.installation_state !== 'enabled'
    ) ||
    (entries.length > 0 ? route.state !== 'enabled' : route.state !== 'disabled')
  ) {
    throw new Error('plugin_notification_provider_order_reflection_invalid');
  }
  const result: NotificationProviderOrder = {
    tenantId: route.tenant_id,
    channel: route.channel as NotificationProviderOrder['channel'],
    configVersion,
    state: route.state,
    installationIds: entries.map((entry) => entry.installation_id),
  };
  if (
    expected &&
    (route.channel !== expected.input.channel ||
      route.last_operation_id !== expected.input.operationId ||
      route.order_fingerprint !== expected.orderFingerprint ||
      result.installationIds.join('\0') !== expected.input.installationIds.join('\0'))
  ) {
    throw new Error('plugin_notification_provider_order_idempotency_conflict');
  }
  return result;
}

export class D1NotificationProviderOrderStore {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000)
  ) {}

  async replace(input: unknown): Promise<NotificationProviderOrder> {
    validate(input);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new Error('plugin_notification_provider_order_now_invalid');
    }
    const session = primary(this.db);
    const orderFingerprint = await fingerprint(input);
    const current = await load(session, input.tenantId, input.channel);
    if (current.route?.last_operation_id === input.operationId) {
      const adopted = reflect(current, { input, orderFingerprint });
      if (!adopted) throw new Error('plugin_notification_provider_order_reflection_invalid');
      return adopted;
    }
    const currentVersion = current.route
      ? integer(
          current.route.config_version,
          1,
          'plugin_notification_provider_order_reflection_invalid'
        )
      : 0;
    if (currentVersion !== input.expectedConfigVersion) {
      throw new Error('plugin_notification_provider_order_version_conflict');
    }
    const nextVersion = currentVersion + 1;
    const state = input.installationIds.length > 0 ? 'enabled' : 'disabled';
    const statements = current.route
      ? [
          ...current.entries.map((entry) =>
            session
              .prepare(
                `DELETE FROM plugin_runner_notification_route_entries
                  WHERE tenant_id = ? AND channel = ? AND config_version = ? AND priority = ?`
              )
              .bind(input.tenantId, input.channel, currentVersion, entry.priority)
          ),
          session
            .prepare(
              `UPDATE plugin_runner_notification_route_sets
                  SET config_version = ?, state = ?, last_operation_id = ?,
                      order_fingerprint = ?, updated_at = ?
                WHERE tenant_id = ? AND channel = ? AND config_version = ?`
            )
            .bind(
              nextVersion,
              state,
              input.operationId,
              orderFingerprint,
              now,
              input.tenantId,
              input.channel,
              currentVersion
            ),
        ]
      : [
          session
            .prepare(
              `INSERT INTO plugin_runner_notification_route_sets (
                 tenant_id, channel, config_version, state, last_operation_id,
                 order_fingerprint, created_at, updated_at
               ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`
            )
            .bind(
              input.tenantId,
              input.channel,
              state,
              input.operationId,
              orderFingerprint,
              now,
              now
            ),
        ];
    statements.push(
      ...input.installationIds.map((installationId, priority) =>
        session
          .prepare(
            `INSERT INTO plugin_runner_notification_route_entries (
               tenant_id, channel, config_version, priority, installation_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(input.tenantId, input.channel, nextVersion, priority, installationId, now)
      )
    );
    try {
      assertBatch(await session.batch(statements), statements.length);
    } catch {
      try {
        const reflected = await load(session, input.tenantId, input.channel);
        const adopted = reflect(reflected, { input, orderFingerprint });
        if (adopted?.configVersion === nextVersion) return adopted;
      } catch {
        // The complete desired reflection was not committed.
      }
      throw new Error('plugin_notification_provider_order_batch_failed');
    }
    const reflected = reflect(await load(session, input.tenantId, input.channel), {
      input,
      orderFingerprint,
    });
    if (!reflected || reflected.configVersion !== nextVersion) {
      throw new Error('plugin_notification_provider_order_reflection_invalid');
    }
    return reflected;
  }

  async resolve(input: {
    tenantId: string;
    channel: ReplaceNotificationProviderOrderInput['channel'];
  }): Promise<NotificationProviderOrder> {
    if (!SAFE_ID.test(input.tenantId) || !['email', 'sms', 'push'].includes(input.channel)) {
      throw new Error('plugin_notification_provider_order_input_invalid');
    }
    const reflected = reflect(await load(primary(this.db), input.tenantId, input.channel));
    if (!reflected) throw new Error('plugin_notification_provider_order_unavailable');
    return reflected;
  }
}
