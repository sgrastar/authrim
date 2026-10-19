import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SWALLOWED_IDENTITY_MAPPING_FAILURE_LOG_WINDOW_MS as WINDOW,
  classifySwallowedIdentityMappingFailure,
  logSwallowedIdentityMappingFailure,
  resetSwallowedIdentityMappingFailureThrottle,
  swallowedIdentityMappingFailureReasonCode,
} from '../identity-mapping-swallowed-failure';

/**
 * Where the identity mapping cannot be resolved and the request goes on without it, the failure is
 * recorded as an error (once per window per Worker instance for the same kind of failure), with
 * nothing of the error's message or the user.
 */

function entries(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)));
}

describe('swallowed identity mapping failure record', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetSwallowedIdentityMappingFailureThrottle();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errorSpy.mockRestore());

  const failure = (overrides: Partial<Parameters<typeof logSwallowedIdentityMappingFailure>[0]>) =>
    logSwallowedIdentityMappingFailure({
      component: 'OIDC-IDENTITY-MAPPING',
      tenantId: 'tenant-a',
      clientId: 'client-a',
      adminDatabaseBound: true,
      error: new Error('no such table: field_mapping_activations'),
      now: 1_000,
      ...overrides,
    });

  it('records an error with the component, tenant, app, kind and reason code', () => {
    failure({});

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(entries(errorSpy)[0]).toMatchObject({
      level: 'error',
      tenantId: 'tenant-a',
      clientId: 'client-a',
      module: 'OIDC-IDENTITY-MAPPING',
      action: 'identity_mapping_resolution_swallowed',
      failure_kind: 'query_failed',
      reason_code: 'no_such_table',
      suppressed_since_last_log: 0,
    });
  });

  it('carries neither the error message nor a stack', () => {
    failure({
      error: new Error('D1_ERROR: no such table: users WHERE email = alice@example.com'),
    });

    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).not.toContain('alice@example.com');
    expect(line).not.toContain('WHERE');
    expect(JSON.parse(line)).not.toHaveProperty('error');
    expect(entries(errorSpy)[0].reason_code).toBe('no_such_table');
  });

  it('names the missing Admin database as the kind, whatever the error', () => {
    failure({ adminDatabaseBound: false, error: new Error('no such table: x') });

    expect(entries(errorSpy)[0]).toMatchObject({
      failure_kind: 'admin_database_unbound',
      reason_code: 'no_such_table',
    });
  });

  it.each([
    [new Error('D1_ERROR: boom'), 'query_failed', 'd1_error'],
    [new Error('The operation timed out'), 'query_failed', 'database_timeout'],
    [Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }), 'other', 'SQLITE_BUSY'],
    [new TypeError('Cannot read properties of undefined'), 'other', 'TypeError'],
    ['a string', 'other', 'unknown'],
  ])('classifies %#', (error, kind, reasonCode) => {
    expect(classifySwallowedIdentityMappingFailure({ adminDatabaseBound: true, error })).toEqual({
      kind,
      reasonCode,
    });
  });

  it('does not take an own code that is not a plain token as the reason', () => {
    const error = Object.assign(new Error('x'), { code: 'user alice@example.com / token abc' });
    expect(swallowedIdentityMappingFailureReasonCode(error)).toBe('Error');
  });

  describe('flood control', () => {
    it('records the same kind of failure once per window and counts the repeats', () => {
      failure({ now: 1_000 });
      failure({ now: 1_001, clientId: 'client-b' });
      failure({ now: 1_000 + WINDOW - 1 });
      expect(errorSpy).toHaveBeenCalledTimes(1);

      failure({ now: 1_000 + WINDOW });
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(entries(errorSpy)[1]).toMatchObject({ suppressed_since_last_log: 2 });

      failure({ now: 1_000 + WINDOW + 1 });
      expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('records failures of another tenant, component, kind or reason on their own', () => {
      failure({});
      failure({ tenantId: 'tenant-b' });
      failure({ component: 'LOGIN-RUNTIME-FLOW' });
      failure({ adminDatabaseBound: false });
      failure({ error: new Error('D1_ERROR: x') });

      expect(errorSpy).toHaveBeenCalledTimes(5);
    });

    it('does not go quiet for good when the clock moves backwards', () => {
      failure({ now: 10_000 });
      failure({ now: 5_000 });

      expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    describe('when more distinct keys arrive than the table holds (256)', () => {
      const KEYS = 300;
      const cycle = (rounds: number, at: (round: number) => number = () => 1_000) => {
        for (let round = 0; round < rounds; round += 1) {
          for (let index = 0; index < KEYS; index += 1) {
            failure({ tenantId: `tenant-${index}`, now: at(round) });
          }
        }
      };

      it('does not log again on every pass of a cycle of distinct keys within the window', () => {
        cycle(5, (round) => 1_000 + round);

        // 256 keys held, once each; the rest share one overflow record, once.
        expect(errorSpy).toHaveBeenCalledTimes(257);
      });

      it('marks the shared record, keeps the original kind and reason and the tenant', () => {
        cycle(1);

        const overflowed = entries(errorSpy).filter((entry) => entry.throttle_overflow === true);
        expect(overflowed).toHaveLength(1);
        expect(overflowed[0]).toMatchObject({
          tenantId: 'tenant-256',
          failure_kind: 'query_failed',
          reason_code: 'no_such_table',
          suppressed_since_last_log: 0,
        });
        expect(entries(errorSpy).filter((entry) => entry.throttle_overflow !== true)).toHaveLength(
          256
        );
      });

      it('records again after the window, the overflow record reporting its repeats', () => {
        cycle(2);
        const before = errorSpy.mock.calls.length;
        cycle(1, () => 1_000 + WINDOW);

        const records = entries(errorSpy).slice(before);
        // Every key's window has passed: the table is pruned and each key is recorded afresh
        // (the first 256 distinct ones), the rest sharing the overflow record again.
        expect(records).toHaveLength(257);
        // 44 keys overflow per pass, two passes: one was recorded, 87 repeats were not.
        expect(records.find((entry) => entry.throttle_overflow === true)).toMatchObject({
          suppressed_since_last_log: 87,
        });
      });

      it('keeps a held key suppressed when other keys overflow', () => {
        failure({ tenantId: 'held', now: 1_000 });
        cycle(1);
        const before = errorSpy.mock.calls.length;

        failure({ tenantId: 'held', now: 1_500 });

        expect(errorSpy.mock.calls.length).toBe(before);
      });

      it('reclaims expired keys whose reason code is itself "overflow"', () => {
        const overflowCode = Object.assign(new Error('x'), { code: 'overflow' });
        for (let index = 0; index < 256; index += 1) {
          failure({ tenantId: `old-${index}`, error: overflowCode, now: 1_000 });
        }
        errorSpy.mockClear();

        // After the window the 256 old keys are expired; new keys get their own records again.
        for (let index = 0; index < 256; index += 1) {
          failure({ tenantId: `new-${index}`, now: 1_000 + WINDOW });
        }

        const records = entries(errorSpy);
        expect(records).toHaveLength(256);
        expect(records.some((entry) => entry.throttle_overflow === true)).toBe(false);
      });

      it('shares one overflow record per component, not across components', () => {
        cycle(1);
        const before = errorSpy.mock.calls.length;

        failure({ component: 'LOGIN-RUNTIME-FLOW', tenantId: 'tenant-x' });
        failure({ component: 'LOGIN-RUNTIME-FLOW', tenantId: 'tenant-y' });

        const records = entries(errorSpy).slice(before);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ module: 'LOGIN-RUNTIME-FLOW', throttle_overflow: true });
      });
    });
  });

  it('uses the logger it is given (the request logger) instead of making one', () => {
    const logger = { module: vi.fn(), error: vi.fn() };
    logger.module.mockReturnValue(logger);

    failure({ logger: logger as never });

    expect(logger.module).toHaveBeenCalledWith('OIDC-IDENTITY-MAPPING');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('could not be resolved'),
      expect.objectContaining({ clientId: 'client-a', failure_kind: 'query_failed' })
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
