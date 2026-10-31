import { describe, expect, it } from 'vitest';
import { buildSAMLAssertionTiming, resolveSAMLAuthnInstant } from '../assertion-timing';

describe('buildSAMLAssertionTiming', () => {
  it('uses one base time with clock-skewed NotBefore and validity-based NotOnOrAfter', () => {
    expect(
      buildSAMLAssertionTiming({
        now: new Date('2024-01-15T10:30:00Z'),
        assertionValiditySeconds: 300,
        notBeforeSkewSeconds: 60,
      })
    ).toEqual({
      issueInstant: '2024-01-15T10:30:00Z',
      authnInstant: '2024-01-15T10:30:00Z',
      notBefore: '2024-01-15T10:29:00Z',
      notOnOrAfter: '2024-01-15T10:35:00Z',
    });
  });

  it('rejects invalid assertion validity', () => {
    expect(() => buildSAMLAssertionTiming({ assertionValiditySeconds: 0 })).toThrow(
      'SAML assertion validity must be a positive number of seconds'
    );
  });
});

describe('buildSAMLAssertionTiming AuthnInstant', () => {
  const now = new Date('2024-01-15T10:30:00Z');

  it('is the authentication time, apart from the issue instant, formatted as the other instants', () => {
    const timing = buildSAMLAssertionTiming({
      now,
      authenticatedAtMs: Date.parse('2024-01-15T07:12:34.789Z'),
    });
    expect(timing.issueInstant).toBe('2024-01-15T10:30:00Z');
    expect(timing.authnInstant).toBe('2024-01-15T07:12:34Z');
    // The validity window is still the issue instant's.
    expect(timing.notBefore).toBe('2024-01-15T10:29:00Z');
    expect(timing.notOnOrAfter).toBe('2024-01-15T10:35:00Z');
  });

  it('is the issue instant where no authentication time is given', () => {
    expect(buildSAMLAssertionTiming({ now }).authnInstant).toBe('2024-01-15T10:30:00Z');
  });

  it.each([
    ['later than the issue instant', Date.parse('2024-01-15T10:30:05Z'), '2024-01-15T10:30:00Z'],
    ['NaN', Number.NaN, '2024-01-15T10:30:00Z'],
    ['infinite', Number.POSITIVE_INFINITY, '2024-01-15T10:30:00Z'],
    ['hugely negative', -1e20, '2024-01-15T10:30:00Z'],
    ['seconds read as milliseconds', 1_705_314_600, '2024-01-15T10:30:00Z'],
  ])('never states an authentication time that is %s', (_name, authenticatedAtMs, expected) => {
    expect(buildSAMLAssertionTiming({ now, authenticatedAtMs }).authnInstant).toBe(expected);
  });
});

describe('resolveSAMLAuthnInstant', () => {
  const nowMs = Date.parse('2024-01-15T10:30:00Z');
  const earlier = (seconds: number) => nowMs - seconds * 1000;

  it('is proven_at when that is all the session has', () => {
    expect(resolveSAMLAuthnInstant({ proven_at: earlier(600) }, { nowMs })).toEqual({
      ms: earlier(600),
      source: 'proven_at',
    });
  });

  it('is the re-authentication when that is newer than proven_at, and proven_at when it is older', () => {
    expect(
      resolveSAMLAuthnInstant(
        { proven_at: earlier(7200), reauth_proven_at: earlier(30) },
        { nowMs }
      )
    ).toEqual({ ms: earlier(30), source: 'reauth_proven_at' });
    expect(
      resolveSAMLAuthnInstant(
        { proven_at: earlier(30), reauth_proven_at: earlier(7200) },
        { nowMs }
      )
    ).toEqual({ ms: earlier(30), source: 'proven_at' });
  });

  it('reads authTime and auth_time as seconds', () => {
    const seconds = earlier(900) / 1000;
    expect(resolveSAMLAuthnInstant({ authTime: seconds }, { nowMs })).toEqual({
      ms: earlier(900),
      source: 'auth_time',
    });
    expect(resolveSAMLAuthnInstant({ auth_time: seconds }, { nowMs })).toEqual({
      ms: earlier(900),
      source: 'auth_time',
    });
  });

  it('takes the latest of the three, the login time of a step-up included', () => {
    // A step-up login combined into a session: proven_at is rewritten to the oldest proof, the
    // session's authTime is that of the login just made.
    expect(
      resolveSAMLAuthnInstant({ proven_at: earlier(7200), authTime: earlier(20) / 1000 }, { nowMs })
    ).toEqual({ ms: earlier(20), source: 'auth_time' });
  });

  it('falls back to the creation time of the session', () => {
    expect(
      resolveSAMLAuthnInstant({ amr: ['external_idp'] }, { nowMs, createdAt: earlier(60) })
    ).toEqual({
      ms: earlier(60),
      source: 'session_created_at',
    });
    expect(resolveSAMLAuthnInstant(undefined, { nowMs, createdAt: earlier(60) })).toEqual({
      ms: earlier(60),
      source: 'session_created_at',
    });
  });

  it('falls back to the issue instant when nothing is recorded', () => {
    expect(resolveSAMLAuthnInstant({ amr: ['pwd'] }, { nowMs })).toEqual({
      ms: nowMs,
      source: 'unknown',
    });
    expect(resolveSAMLAuthnInstant(undefined, { nowMs })).toEqual({ ms: nowMs, source: 'unknown' });
  });

  it('reads a time a little ahead of this clock as now, and one well ahead as unknown', () => {
    expect(resolveSAMLAuthnInstant({ proven_at: nowMs + 30_000 }, { nowMs })).toEqual({
      ms: nowMs,
      source: 'proven_at',
    });
    // Ignored, so the next best time (the creation time) is used rather than the future one.
    expect(
      resolveSAMLAuthnInstant({ proven_at: nowMs + 3_600_000 }, { nowMs, createdAt: earlier(120) })
    ).toEqual({ ms: earlier(120), source: 'session_created_at' });
    expect(resolveSAMLAuthnInstant({ proven_at: nowMs + 3_600_000 }, { nowMs })).toEqual({
      ms: nowMs,
      source: 'unknown',
    });
  });

  it('accepts a time less than the skew ahead (as now) and rejects one the skew or more ahead', () => {
    // The default skew is 60 seconds.
    expect(resolveSAMLAuthnInstant({ proven_at: nowMs + 59_999 }, { nowMs })).toEqual({
      ms: nowMs,
      source: 'proven_at',
    });
    expect(resolveSAMLAuthnInstant({ proven_at: nowMs + 60_000 }, { nowMs })).toEqual({
      ms: nowMs,
      source: 'unknown',
    });
    // Rejected, so an older valid candidate wins, or the creation time is used.
    expect(
      resolveSAMLAuthnInstant(
        { proven_at: nowMs + 60_000, reauth_proven_at: earlier(300) },
        { nowMs }
      )
    ).toEqual({ ms: earlier(300), source: 'reauth_proven_at' });
    expect(
      resolveSAMLAuthnInstant({ proven_at: nowMs + 60_000 }, { nowMs, createdAt: earlier(120) })
    ).toEqual({ ms: earlier(120), source: 'session_created_at' });
  });

  it.each([
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['negative', -5],
    ['zero', 0],
    ['a string', String(earlier(60))],
    ['null', null],
    ['an object', {}],
  ])('ignores a recorded time that is %s', (_name, value) => {
    expect(
      resolveSAMLAuthnInstant(
        { proven_at: value, reauth_proven_at: value, authTime: value, auth_time: value },
        { nowMs, createdAt: value }
      )
    ).toEqual({ ms: nowMs, source: 'unknown' });
  });

  it('rejects seconds where milliseconds are expected and milliseconds where seconds are', () => {
    // 1.7e9 as proven_at would be January 1970.
    expect(resolveSAMLAuthnInstant({ proven_at: earlier(60) / 1000 }, { nowMs })).toEqual({
      ms: nowMs,
      source: 'unknown',
    });
    // Milliseconds as authTime would be the year 55000.
    expect(resolveSAMLAuthnInstant({ authTime: earlier(60) }, { nowMs })).toEqual({
      ms: nowMs,
      source: 'unknown',
    });
    expect(resolveSAMLAuthnInstant({ auth_time: earlier(60) }, { nowMs })).toEqual({
      ms: nowMs,
      source: 'unknown',
    });
  });

  it('lets a usable time count when another recorded one is not', () => {
    expect(
      resolveSAMLAuthnInstant(
        { proven_at: Number.NaN, reauth_proven_at: earlier(40), authTime: 'x' },
        { nowMs }
      )
    ).toEqual({ ms: earlier(40), source: 'reauth_proven_at' });
  });
});
