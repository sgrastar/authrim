/**
 * Email and Slack delivery of admin console notices, run every minute.
 *
 * Planning: each new notice gets one delivery row per admin to email (the admins of its
 * audience who hold what the notice needs and want email from its severity) and per enabled
 * Slack channel of its scope whose minimum it reaches. A notice older than a day when first seen,
 * or already closed, is planned with nothing to send.
 *
 * Sending: due rows are leased, then sent. Email is handed to the notification delivery outbox,
 * which retries on its own; Slack is posted here, retried with backoff and given up after
 * MAX_ATTEMPTS. A notice closed in the meantime is not sent.
 */

import type {
  AdminNotice,
  AdminNoticeDelivery,
  AdminNoticeSeverity,
  DatabaseAdapter,
  Env,
} from '@authrim/ar-lib-core';
import {
  ADMIN_NOTICE_EMAIL_DEFAULTS,
  ADMIN_ROLES,
  DEFAULT_ADMIN_SIGN_IN_ROLES,
  AdminNoticeDeliveryRepository,
  AdminNoticeRepository,
  decryptValue,
  hasAdminPermission,
  produceNotificationDelivery,
  requireDedicatedAdminDatabaseAdapter,
  severityReaches,
} from '@authrim/ar-lib-core';

export const NOTICE_PLAN_PER_RUN = 20;
export const NOTICE_SENDS_PER_RUN = 25;
/** Claimed together; each send takes at most SLACK_TIMEOUT_MS, well inside the lease. */
const CLAIM_SIZE = 5;
const LEASE_MS = 2 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 8;
/** At most this many admins of one tenant (and as many platform admins) are considered. */
export const MAX_EMAIL_CANDIDATES = 1000;
const SLACK_TIMEOUT_MS = 10_000;
/** The form of an error kept on a delivery and shown back. */
const ERROR_CODE = /^[a-z0-9_]{1,80}$/;

interface DeliveryLog {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------------------------
// Recipients

interface RoleRow {
  id: string;
  permissions_json: string;
  inherits_from: string | null;
}

function parsePermissions(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function collect(
  role: RoleRow | undefined,
  roles: Map<string, RoleRow>,
  into: Set<string>,
  seen = new Set<string>()
): void {
  if (!role || seen.has(role.id)) return;
  seen.add(role.id);
  for (const permission of parsePermissions(role.permissions_json)) into.add(permission);
  if (role.inherits_from) collect(roles.get(role.inherits_from), roles, into, seen);
}

/**
 * What an admin may see in the console now. Global assignments reach every tenant; tenant
 * assignments only the admin's home tenant (as the auth middleware applies them).
 */
interface AdminView {
  id: string;
  home: string;
  platform: boolean;
  /** Everything in the home tenant: tenant and global assignments. */
  homePermissions: string[];
  /** In any other tenant: global assignments only. */
  globalPermissions: string[];
  /** Holds a sign-in role through a global assignment, so can open other tenants. */
  reachesOtherTenants: boolean;
}

const ID_CHUNK = 40;
const SIGN_IN_ROLES = new Set<string>(DEFAULT_ADMIN_SIGN_IN_ROLES);

const chunks = <T>(items: T[], size = ID_CHUNK): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size)
  );

/**
 * The console view of these admins, computed as the session does: their current role
 * assignments (global, or for their home tenant), with inherited permissions. Inactive admins and
 * admins without a current sign-in role (who cannot open the console) are left out. Role expiry
 * is in milliseconds, as the admin auth middleware compares it.
 */
export async function adminViews(
  adapter: DatabaseAdapter,
  adminIds: string[],
  now: number
): Promise<Map<string, AdminView>> {
  const views = new Map<string, AdminView>();
  for (const ids of chunks([...new Set(adminIds)])) {
    const rows = await adapter.query<{
      admin_user_id: string;
      home: string;
      admin_role_id: string;
      scope_type: string;
      role_name: string;
    }>(
      `SELECT ra.admin_user_id, au.tenant_id AS home, ra.admin_role_id, ra.scope_type,
              r.name AS role_name
         FROM admin_role_assignments ra
         JOIN admin_users au ON au.id = ra.admin_user_id AND au.tenant_id = ra.tenant_id
         JOIN admin_roles r ON r.id = ra.admin_role_id
          AND (r.tenant_id = ra.tenant_id OR (r.tenant_id = 'default' AND r.is_system = 1))
        WHERE ra.admin_user_id IN (${ids.map(() => '?').join(', ')})
          AND au.is_active = 1 AND au.status = 'active'
          AND (ra.scope_type = 'global'
            OR (ra.scope_type = 'tenant' AND (ra.scope_id = au.tenant_id OR ra.scope_id IS NULL)))
          AND (ra.expires_at IS NULL OR ra.expires_at > ?)`,
      [...ids, now]
    );
    const homes = [...new Set(rows.map((row) => row.home))];
    const roles = new Map<string, RoleRow>();
    for (const tenants of chunks(homes)) {
      for (const role of await adapter.query<RoleRow>(
        `SELECT id, permissions_json, inherits_from FROM admin_roles
          WHERE tenant_id IN (${tenants.map(() => '?').join(', ')})
             OR (tenant_id = 'default' AND is_system = 1)`,
        tenants
      )) {
        roles.set(role.id, role);
      }
    }
    const building = new Map<
      string,
      {
        home: string;
        platform: boolean;
        signIn: boolean;
        signInGlobal: boolean;
        all: Set<string>;
        global: Set<string>;
      }
    >();
    for (const row of rows) {
      const view = building.get(row.admin_user_id) ?? {
        home: row.home,
        platform: false,
        signIn: false,
        signInGlobal: false,
        all: new Set<string>(),
        global: new Set<string>(),
      };
      collect(roles.get(row.admin_role_id), roles, view.all);
      if (row.scope_type === 'global') collect(roles.get(row.admin_role_id), roles, view.global);
      if (SIGN_IN_ROLES.has(row.role_name)) {
        view.signIn = true;
        if (row.scope_type === 'global') view.signInGlobal = true;
      }
      if (row.scope_type === 'global' && row.role_name === ADMIN_ROLES.SUPER_ADMIN) {
        view.platform = true;
      }
      building.set(row.admin_user_id, view);
    }
    for (const [id, view] of building) {
      if (!view.signIn) continue;
      const globalPermissions = [...view.global];
      views.set(id, {
        id,
        home: view.home,
        // As hasGlobalPlatformAuthority decides: a global super admin, or `*` held globally.
        platform: view.platform || globalPermissions.includes('*'),
        // Another tenant is opened only with a global sign-in role.
        reachesOtherTenants: view.signInGlobal,
        homePermissions: [...view.all],
        globalPermissions,
      });
    }
  }
  return views;
}

/** Whether the admin sees this notice in the console (its audience and what it needs). */
export function viewSees(view: AdminView | undefined, notice: AdminNotice): boolean {
  if (!view) return false;
  let permissions: string[];
  switch (notice.scope_type) {
    case 'admin_user':
      if (view.id !== notice.admin_user_id) return false;
      permissions = view.homePermissions;
      break;
    case 'platform':
      if (!view.platform) return false;
      permissions = view.globalPermissions;
      break;
    case 'tenant':
    case 'client':
      // In another tenant only what a global assignment gives counts.
      if (view.home === notice.tenant_id) {
        permissions = view.homePermissions;
      } else if (view.reachesOtherTenants) {
        permissions = view.globalPermissions;
      } else {
        return false;
      }
      break;
  }
  if (permissions.length === 0) return false;
  const needs = [
    ...(notice.scope_type === 'client' ? ['admin:clients:read'] : []),
    ...(notice.required_permission ? [notice.required_permission] : []),
  ];
  return needs.every((need) => hasAdminPermission(permissions, need));
}

/** Active admins holding a current global assignment (they can open any tenant). */
async function globalAdminIds(
  adapter: DatabaseAdapter,
  now: number,
  superAdminsOnly: boolean
): Promise<string[]> {
  const rows = await adapter.query<{ id: string }>(
    `SELECT DISTINCT au.id FROM admin_role_assignments ra
       JOIN admin_roles r ON r.id = ra.admin_role_id
        AND (r.tenant_id = ra.tenant_id OR (r.tenant_id = 'default' AND r.is_system = 1))
       JOIN admin_users au ON au.id = ra.admin_user_id AND au.tenant_id = ra.tenant_id
      WHERE ra.scope_type = 'global' ${superAdminsOnly ? 'AND r.name = ?' : ''}
        AND au.is_active = 1 AND au.status = 'active'
        AND (ra.expires_at IS NULL OR ra.expires_at > ?)
      ORDER BY au.id LIMIT ?`,
    superAdminsOnly
      ? [ADMIN_ROLES.SUPER_ADMIN, now, MAX_EMAIL_CANDIDATES]
      : [now, MAX_EMAIL_CANDIDATES]
  );
  return rows.map((row) => row.id);
}

/** The admins who may be emailed a notice, before their preferences. */
export async function emailAudience(
  adapter: DatabaseAdapter,
  notice: AdminNotice,
  now: number
): Promise<string[]> {
  let candidates: string[];
  if (notice.scope_type === 'admin_user') {
    candidates = notice.admin_user_id ? [notice.admin_user_id] : [];
  } else if (notice.scope_type === 'platform') {
    // Every global admin is a candidate; the view decides who holds platform authority.
    candidates = await globalAdminIds(adapter, now, false);
  } else {
    const members = await adapter.query<{ id: string }>(
      `SELECT id FROM admin_users
        WHERE tenant_id = ? AND is_active = 1 AND status = 'active'
        ORDER BY id LIMIT ?`,
      [notice.tenant_id, MAX_EMAIL_CANDIDATES]
    );
    candidates = [
      ...new Set([...members.map((row) => row.id), ...(await globalAdminIds(adapter, now, false))]),
    ];
  }
  const views = await adminViews(adapter, candidates, now);
  return candidates.filter((id) => viewSees(views.get(id), notice));
}

/** Whether the admin's own choice takes email of this severity. */
function wantsEmail(
  choice: { email_enabled: boolean; email_min_severity: AdminNoticeSeverity } | undefined,
  severity: AdminNoticeSeverity
): boolean {
  const effective = choice ?? ADMIN_NOTICE_EMAIL_DEFAULTS;
  return effective.email_enabled && severityReaches(severity, effective.email_min_severity);
}

// ---------------------------------------------------------------------------------------------
// Planning

/** D1 calls planning may make in one run, so sending and the minute's other jobs keep theirs. */
export const PLAN_CALL_BUDGET = 300;

/** An adapter that counts the calls made through it. */
function counting(adapter: DatabaseAdapter): { adapter: DatabaseAdapter; calls: () => number } {
  let calls = 0;
  const count =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A) => {
      calls += 1;
      return fn(...args);
    };
  return {
    adapter: {
      ...adapter,
      query: count(adapter.query.bind(adapter)),
      queryOne: count(adapter.queryOne.bind(adapter)),
      execute: count(adapter.execute.bind(adapter)),
      batch: count(adapter.batch.bind(adapter)),
    } as DatabaseAdapter,
    calls: () => calls,
  };
}

export async function planNoticeDeliveries(
  adapter: DatabaseAdapter,
  now: number = Date.now(),
  log?: DeliveryLog,
  callBudget: number = PLAN_CALL_BUDGET
): Promise<{ planned: number; deliveries: number; failed: number }> {
  const metered = counting(adapter);
  adapter = metered.adapter;
  const deliveries = new AdminNoticeDeliveryRepository(adapter);
  const notices = new AdminNoticeRepository(adapter);
  let planned = 0;
  let rows = 0;
  let failed = 0;
  for (const { id } of await deliveries.listUnplanned(NOTICE_PLAN_PER_RUN)) {
    // What is left is planned next minute: a large audience must not use up this run's calls.
    if (metered.calls() >= callBudget) break;
    // One notice that cannot be planned is left for the next run; the others go on.
    try {
      const notice = await notices.findById(id);
      if (!notice) continue;
      const closed =
        notice.resolved_at !== null ||
        (notice.expires_at !== null && notice.expires_at <= now) ||
        notice.created_at < now - STALE_MS;
      const targets: Array<{ channel: 'email' | 'slack'; target_id: string }> = [];
      if (!closed) {
        const audience = await emailAudience(adapter, notice, now);
        const preferences = await deliveries.preferencesOf(audience);
        for (const adminId of audience) {
          if (wantsEmail(preferences.get(adminId), notice.severity)) {
            targets.push({ channel: 'email', target_id: adminId });
          }
        }
        // Slack channels are shared: a notice to one admin is not posted there.
        if (notice.scope_type !== 'admin_user') {
          const channels = await deliveries.channelsFor(
            notice.scope_type === 'platform'
              ? { scope: 'platform' }
              : { scope: 'tenant', tenantId: notice.tenant_id ?? '' },
            notice.severity
          );
          // A notice behind a permission (or about a client) goes only to channels whose
          // registering admin sees it: a channel is not a way around what the notice needs.
          const gated = notice.scope_type === 'client' || notice.required_permission !== null;
          const owners = gated
            ? await adminViews(
                adapter,
                channels.flatMap((channel) => (channel.created_by ? [channel.created_by] : [])),
                now
              )
            : null;
          for (const channel of channels) {
            if (
              owners &&
              !(channel.created_by && viewSees(owners.get(channel.created_by), notice))
            ) {
              continue;
            }
            targets.push({ channel: 'slack', target_id: channel.id });
          }
        }
      }
      if (await deliveries.plan(notice.id, targets, now)) {
        planned += 1;
        rows += targets.length;
      }
    } catch (error) {
      failed += 1;
      log?.warn('Admin notice delivery planning failed', {
        noticeId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { planned, deliveries: rows, failed };
}

// ---------------------------------------------------------------------------------------------
// Sending

const SEVERITY_LABEL: Record<AdminNoticeSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  caution: 'Caution',
  info: 'Information',
};

function consoleLink(env: Env, notice: AdminNotice): string | null {
  const base = env.ADMIN_UI_URL?.replace(/\/+$/, '');
  if (!base || !/^https:\/\//.test(base)) return null;
  return `${base}/admin/integrations/notifications?id=${encodeURIComponent(notice.id)}`;
}

/** Backoff before attempt n+1: one minute, doubling, at most an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1));
}

/** Only Slack Incoming Webhooks: the URL is the secret and the only place we post to. */
export function isSlackWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'hooks.slack.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      /^\/services\/[A-Za-z0-9_/-]+$/.test(url.pathname) &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** Slack's mrkdwn treats these as markup; the notice is plain text. */
function escapeSlack(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

type SendResult =
  | { status: 'sent' | 'dead_letter' | 'skipped'; error?: string }
  | { status: 'failed'; error: string };

async function sendEmail(
  env: Env,
  adapter: DatabaseAdapter,
  notice: AdminNotice,
  delivery: AdminNoticeDelivery,
  now: number
): Promise<SendResult> {
  // Still in the audience, still wanting it: roles and choices may have changed since planning.
  const view = (await adminViews(adapter, [delivery.target_id], now)).get(delivery.target_id);
  if (!viewSees(view, notice)) return { status: 'skipped', error: 'recipient_not_eligible' };
  const choice = (
    await new AdminNoticeDeliveryRepository(adapter).preferencesOf([delivery.target_id])
  ).get(delivery.target_id);
  if (!wantsEmail(choice, notice.severity)) {
    return { status: 'skipped', error: 'recipient_opted_out' };
  }
  const admin = await adapter.queryOne<{ email: string }>(
    `SELECT email FROM admin_users WHERE id = ? AND is_active = 1 AND status = 'active'`,
    [delivery.target_id]
  );
  if (!admin?.email) return { status: 'skipped', error: 'recipient_unavailable' };
  // The outbox matches a retry by its whole input: the expiry is fixed by the delivery's age.
  const expiresAt = Math.floor(delivery.created_at / 1000) + 24 * 60 * 60;
  if (expiresAt * 1000 <= now) return { status: 'skipped', error: 'expired' };
  const link = consoleLink(env, notice);
  const lines = [
    `${SEVERITY_LABEL[notice.severity]}: ${notice.title}`,
    ...(notice.body ? [notice.body] : []),
    ...(link ? [`Open it in the admin console: ${link}`] : []),
  ];
  const key = `admin-notice:${delivery.id}`;
  const result = await produceNotificationDelivery(env, {
    owner:
      notice.scope_type === 'platform'
        ? { owner: 'platform' }
        : { owner: 'tenant', tenantId: notice.tenant_id ?? '' },
    intentId: key,
    outboxId: `notification:${key}`,
    notificationKind: 'admin.notice',
    idempotencyKey: key,
    expiresAt,
    payload: {
      channel: 'email',
      to: admin.email,
      from: env.EMAIL_FROM || 'noreply@authrim.dev',
      subject: `[Authrim] ${SEVERITY_LABEL[notice.severity]}: ${notice.title}`.slice(0, 200),
      body: `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">${lines
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join('')}</body></html>`,
      metadata: { textBody: lines.join('\n\n') },
    },
  });
  // Handed to the outbox, which retries on its own; only a refusal is final here.
  return result.delivery === 'permanent_failure'
    ? { status: 'dead_letter', error: 'email_permanent_failure' }
    : { status: 'sent' };
}

async function sendSlack(
  env: Env,
  adapter: DatabaseAdapter,
  notice: AdminNotice,
  delivery: AdminNoticeDelivery,
  fetcher: typeof fetch,
  now: number
): Promise<SendResult> {
  const channel = await new AdminNoticeDeliveryRepository(adapter).findChannel(delivery.target_id);
  if (!channel || !channel.enabled) return { status: 'skipped', error: 'channel_unavailable' };
  // Its minimum may have been raised since the notice was planned.
  if (!severityReaches(notice.severity, channel.min_severity)) {
    return { status: 'skipped', error: 'below_channel_minimum' };
  }
  // Behind a permission: the registering admin must still see it (planned before, or since lost).
  if (notice.scope_type === 'client' || notice.required_permission !== null) {
    const owner = channel.created_by
      ? (await adminViews(adapter, [channel.created_by], now)).get(channel.created_by)
      : undefined;
    if (!viewSees(owner, notice)) return { status: 'skipped', error: 'channel_owner_not_eligible' };
  }
  if (!env.PII_ENCRYPTION_KEY) return { status: 'failed', error: 'encryption_key_unavailable' };
  const decrypted = await decryptValue(channel.webhook_url_encrypted, env.PII_ENCRYPTION_KEY);
  const url = decrypted.decrypted;
  if (!decrypted.wasEncrypted || !isSlackWebhookUrl(url))
    return { status: 'dead_letter', error: 'webhook_url_invalid' };
  const link = consoleLink(env, notice);
  const text = [
    `*${SEVERITY_LABEL[notice.severity]}*: ${escapeSlack(notice.title)}`,
    ...(notice.body ? [escapeSlack(notice.body)] : []),
    ...(link ? [`<${link}|Open in the admin console>`] : []),
  ].join('\n');
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      redirect: 'manual',
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.name : 'network_error' };
  }
  if (response.ok) return { status: 'sent' };
  const error = `slack_http_${response.status}`;
  // Slack answers 4xx for a URL that no longer works; only rate limits are worth retrying.
  return response.status === 429 || response.status >= 500
    ? { status: 'failed', error }
    : { status: 'dead_letter', error };
}

export async function sendDueNoticeDeliveries(
  env: Env,
  adapter: DatabaseAdapter,
  now: number = Date.now(),
  fetcher: typeof fetch = fetch,
  clock: () => number = () => now,
  log?: DeliveryLog
): Promise<Record<string, number>> {
  const repository = new AdminNoticeDeliveryRepository(adapter);
  const notices = new AdminNoticeRepository(adapter);
  const token = crypto.randomUUID();
  const counts: Record<string, number> = {};
  let handled = 0;
  // A few at a time, so a lease always outlasts the sends made under it.
  while (handled < NOTICE_SENDS_PER_RUN) {
    const claimed = await repository.claimDue(clock(), CLAIM_SIZE, LEASE_MS, token);
    if (claimed.length === 0) break;
    for (const delivery of claimed) {
      handled += 1;
      // Lost to another run meanwhile (its lease ran out): that run sends it.
      if (!(await repository.renewLease(delivery.id, token, clock(), LEASE_MS))) continue;
      const at = clock();
      let result: SendResult;
      const notice = await notices.findById(delivery.notice_id);
      if (
        !notice ||
        notice.resolved_at !== null ||
        (notice.expires_at !== null && notice.expires_at <= at)
      ) {
        result = { status: 'skipped', error: 'notice_closed' };
      } else {
        try {
          result =
            delivery.channel === 'email'
              ? await sendEmail(env, adapter, notice, delivery, at)
              : await sendSlack(env, adapter, notice, delivery, fetcher, at);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'send_failed';
          // An intent with this key exists but does not match: it is not sent again from here,
          // and the row says so instead of claiming it was sent.
          result = message.includes('notification_intent_idempotency_conflict')
            ? { status: 'skipped', error: 'outbox_intent_conflict' }
            : { status: 'failed', error: message };
        }
      }
      if (result.status === 'failed' && delivery.attempts >= MAX_ATTEMPTS) {
        result = { status: 'dead_letter', error: result.error };
      }
      // Only a code is kept and shown back, whichever path the error came by.
      if (result.error !== undefined && !ERROR_CODE.test(result.error)) {
        log?.warn('Admin notice delivery error kept as send_failed', {
          deliveryId: delivery.id,
          error: result.error,
        });
        result = { ...result, error: 'send_failed' };
      }
      await repository.finish(
        delivery.id,
        token,
        result.status === 'failed'
          ? { ...result, nextAttemptAt: at + retryDelayMs(delivery.attempts) }
          : result,
        at
      );
      counts[result.status] = (counts[result.status] ?? 0) + 1;
    }
  }
  return counts;
}

/** The scheduled run: never throws, so the rest of the minute's jobs go on. */
export async function processScheduledAdminNoticeDelivery(
  env: Env,
  log: DeliveryLog,
  now: number = Date.now()
): Promise<void> {
  try {
    const adapter = requireDedicatedAdminDatabaseAdapter(env, 'admin-notice-delivery');
    let plan: Record<string, number> = {};
    try {
      plan = await planNoticeDeliveries(adapter, now, log);
    } catch (error) {
      // Planning failing must not hold back what is already due.
      log.warn('Admin notice delivery planning failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const sent = await sendDueNoticeDeliveries(env, adapter, now, fetch, () => Date.now(), log);
    if ((plan.planned ?? 0) > 0 || Object.keys(sent).length > 0) {
      log.info('Admin notice deliveries', { ...plan, ...sent });
    }
  } catch (error) {
    log.warn('Admin notice delivery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
