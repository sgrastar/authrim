import { describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { createAuditLog } from '../audit-log';
import {
  ACCOUNT_EVENTS,
  AUTH_EVENTS,
  CLIENT_EVENTS,
  CONSENT_EVENTS,
  DOMAIN_EVENTS,
  SCIM_EVENTS,
  SECURITY_EVENTS,
  SESSION_EVENTS,
  SETTINGS_EVENTS,
  TOKEN_EVENTS,
  USER_EVENTS,
} from '../../types/events/event-types';

/**
 * The unified event_log mirror of audit_log, through the real core schema: a failed event must
 * be recorded as a failure with its error code, never as a success.
 */
function mirrorEnv() {
  const { db, adapter: base } = sqliteAdapter();
  // The rest of the adapter surface, so the audit service uses it as an adapter rather than D1.
  const adapter = Object.assign(base, {
    transaction: () => Promise.reject(new Error('unused')),
    isHealthy: async () => true,
    getType: () => 'd1',
    close: async () => {},
  });
  const env = { DB: adapter, DB_PII: adapter } as unknown as Env;
  const row = (id: string) =>
    db
      .prepare(
        `SELECT event_type, result, error_code, anonymized_user_id, details_json
           FROM event_log WHERE id = ?`
      )
      .get(id) as
      | {
          event_type: string;
          result: string;
          error_code: string | null;
          anonymized_user_id: string | null;
          details_json: string | null;
        }
      | undefined;
  return { env, row };
}

const base = {
  tenantId: 'default',
  userId: 'system',
  resource: 'auth',
  resourceId: 'event',
  ipAddress: 'system',
  userAgent: 'event-dispatcher',
  severity: 'info' as const,
};

describe('createAuditLog event_log mirror', () => {
  it('records a failed sign-in as a failure with its error code', async () => {
    const { env, row } = mirrorEnv();
    await createAuditLog(env, {
      ...base,
      id: 'evt_passkey_failed',
      action: 'auth.passkey.failed',
      metadata: JSON.stringify({
        method: 'passkey',
        clientId: 'client_1',
        errorCode: 'credential_not_found',
      }),
    });

    expect(row('evt_passkey_failed')).toMatchObject({
      event_type: 'auth.passkey.failed',
      result: 'failure',
      error_code: 'credential_not_found',
      anonymized_user_id: null,
    });
  });

  it('records an email-code failure with a snake_case error code as a failure', async () => {
    const { env, row } = mirrorEnv();
    await createAuditLog(env, {
      ...base,
      id: 'evt_email_failed',
      action: 'auth.email_code.failed',
      metadata: JSON.stringify({ method: 'email_code', error_code: 'invalid_code' }),
    });
    await createAuditLog(env, {
      ...base,
      id: 'evt_email_send_failed',
      action: 'auth.email_code.send_failed',
      metadata: JSON.stringify({ method: 'email_code', reason: 'delivery_failed' }),
    });

    expect(row('evt_email_failed')).toMatchObject({
      result: 'failure',
      error_code: 'invalid_code',
    });
    expect(row('evt_email_send_failed')).toMatchObject({ result: 'failure', error_code: null });
  });

  it('keeps successful events as successes without an error code', async () => {
    const { env, row } = mirrorEnv();
    await createAuditLog(env, {
      ...base,
      id: 'evt_login_succeeded',
      action: 'auth.login.succeeded',
      metadata: JSON.stringify({ method: 'passkey', clientId: 'client_1' }),
    });
    // An error code on a successful event is not an error of that event.
    await createAuditLog(env, {
      ...base,
      id: 'evt_success_with_code',
      action: 'user.login',
      metadata: JSON.stringify({ errorCode: 'stale_code' }),
    });

    expect(row('evt_login_succeeded')).toMatchObject({ result: 'success', error_code: null });
    expect(row('evt_success_with_code')).toMatchObject({ result: 'success', error_code: null });
  });

  it('takes an explicit result from the event data over the action name', async () => {
    const { env, row } = mirrorEnv();
    await createAuditLog(env, {
      ...base,
      id: 'evt_explicit_failure',
      action: 'scim.user.create',
      metadata: JSON.stringify({ result: 'failure', errorCode: 'scim_conflict' }),
    });
    await createAuditLog(env, {
      ...base,
      id: 'evt_explicit_partial',
      action: 'scim.bulk',
      metadata: JSON.stringify({ result: 'partial' }),
    });
    await createAuditLog(env, {
      ...base,
      id: 'evt_unknown_result',
      action: 'auth.totp.failed',
      metadata: JSON.stringify({ result: 'ok' }),
    });

    expect(row('evt_explicit_failure')).toMatchObject({
      result: 'failure',
      error_code: 'scim_conflict',
    });
    // Mapping Set saves state 'saved' / 'failed'.
    await createAuditLog(env, {
      ...base,
      id: 'evt_mapping_set_failed',
      action: 'identity_mapping.set.saved',
      metadata: JSON.stringify({ result: 'failed', stage_failed: 'validate' }),
    });
    await createAuditLog(env, {
      ...base,
      id: 'evt_mapping_set_saved',
      action: 'identity_mapping.set.saved',
      metadata: JSON.stringify({ result: 'saved' }),
    });

    expect(row('evt_explicit_partial')).toMatchObject({ result: 'partial' });
    expect(row('evt_mapping_set_failed')).toMatchObject({ result: 'failure' });
    expect(row('evt_mapping_set_saved')).toMatchObject({ result: 'success' });
    // A value outside success/failure/partial is not a result; the action name decides.
    expect(row('evt_unknown_result')).toMatchObject({ result: 'failure' });
  });

  it('leaves out an error code that is not a code', async () => {
    const { env, row } = mirrorEnv();
    await createAuditLog(env, {
      ...base,
      id: 'evt_free_text_code',
      action: 'auth.password.failed',
      metadata: JSON.stringify({ errorCode: 'no user alice@example.com' }),
    });
    await createAuditLog(env, {
      ...base,
      id: 'evt_long_code',
      action: 'auth.password.failed',
      metadata: JSON.stringify({ errorCode: 'x'.repeat(129) }),
    });
    await createAuditLog(env, {
      ...base,
      id: 'evt_non_string_code',
      action: 'auth.password.failed',
      metadata: JSON.stringify({ errorCode: 42 }),
    });

    expect(row('evt_free_text_code')).toMatchObject({ result: 'failure', error_code: null });
    expect(row('evt_long_code')).toMatchObject({ result: 'failure', error_code: null });
    expect(row('evt_non_string_code')).toMatchObject({ result: 'failure', error_code: null });
  });

  it('classifies every declared event type, so a new failure type cannot default to success', async () => {
    const declared = [
      AUTH_EVENTS,
      SESSION_EVENTS,
      TOKEN_EVENTS,
      CONSENT_EVENTS,
      USER_EVENTS,
      ACCOUNT_EVENTS,
      CLIENT_EVENTS,
      SECURITY_EVENTS,
      DOMAIN_EVENTS,
      SETTINGS_EVENTS,
      SCIM_EVENTS,
    ].flatMap((group) => Object.values(group) as string[]);
    // Reviewed: these record an operation that happened (a revocation, a user's denial, a lock),
    // not one that failed, so they are successes.
    const deliberateOutcomes = new Set([
      'token.access.revoked',
      'token.refresh.revoked',
      'token.batch.revoked',
      'consent.denied',
      'consent.item_denied',
      'consent.revoked',
      'consent.expired',
      'security.rate_limit.exceeded',
      'security.account.locked',
      'security.account.unlocked',
      'scim.token.revoke',
    ]);
    const failed = (type: string) => /(^|[._])failed$/u.test(type);
    // A failure-sounding name must be a `failed` action or a reviewed outcome above.
    const unclassified = declared.filter(
      (type) =>
        /(fail|deni|deny|reject|block|lock|timeout|timed_out|error|abort|revok|expir|exceed)/u.test(
          type.split('.').pop() ?? ''
        ) &&
        !failed(type) &&
        !deliberateOutcomes.has(type)
    );
    expect(unclassified).toEqual([]);

    const { env, row } = mirrorEnv();
    for (const [index, type] of declared.entries()) {
      await createAuditLog(env, {
        ...base,
        id: `evt_declared_${index}`,
        action: type,
        metadata: '{}',
      });
      expect(row(`evt_declared_${index}`), type).toMatchObject({
        result: failed(type) ? 'failure' : 'success',
      });
    }
    expect(declared.filter(failed).length).toBeGreaterThanOrEqual(12);
  });

  it('does not put the actor user id in the anonymized user column', async () => {
    const { env, row } = mirrorEnv();
    await createAuditLog(env, {
      ...base,
      id: 'evt_user_event',
      userId: 'user_raw_1',
      action: 'auth.login.failed',
      metadata: JSON.stringify({ method: 'password', errorCode: 'invalid_credentials' }),
    });

    expect(row('evt_user_event')).toMatchObject({
      result: 'failure',
      error_code: 'invalid_credentials',
      anonymized_user_id: null,
    });
  });
});
