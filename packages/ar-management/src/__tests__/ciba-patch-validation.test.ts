import { describe, expect, it } from 'vitest';
import { validateCategoryPatch, validateCibaPatch } from '../routes/settings-v2/patch-validation';

const patch = (
  set: Record<string, unknown>,
  extra: { clear?: string[]; disable?: string[] } = {}
) => ({
  ifMatch: '',
  set,
  ...extra,
});

const current = {
  'ciba.expires_in': 300,
  'ciba.min_expires_in': 60,
  'ciba.max_expires_in': 600,
  'ciba.poll_interval': 5,
  'ciba.min_interval': 2,
  'ciba.max_interval': 60,
};

describe('validateCibaPatch', () => {
  it('accepts a patch with no CIBA bounds in it', () => {
    expect(validateCibaPatch(patch({ 'ciba.binding_message_required': true }))).toBeNull();
    expect(validateCibaPatch(patch({ 'ciba.max_binding_message_length': 200 }))).toBeNull();
  });

  it.each([
    [{ 'ciba.min_expires_in': 300, 'ciba.max_expires_in': 200 }, /min_expires_in.*max_expires_in/],
    [{ 'ciba.min_interval': 20, 'ciba.max_interval': 10 }, /min_interval.*max_interval/],
    [{ 'ciba.min_expires_in': 200, 'ciba.expires_in': 100 }, /expires_in.*below.*min_expires_in/],
    [{ 'ciba.max_expires_in': 100, 'ciba.expires_in': 150 }, /expires_in.*above.*max_expires_in/],
    [{ 'ciba.min_interval': 10, 'ciba.poll_interval': 5 }, /poll_interval.*below.*min_interval/],
    [{ 'ciba.max_interval': 10, 'ciba.poll_interval': 20 }, /poll_interval.*above.*max_interval/],
    [{ 'ciba.min_interval': 1 }, /min_interval must be at least 2/],
  ])('refuses %j within the patch alone', (set, message) => {
    expect(validateCibaPatch(patch(set))).toMatch(message);
  });

  it('accepts equal bounds and values on a bound', () => {
    expect(
      validateCibaPatch(
        patch({
          'ciba.min_expires_in': 120,
          'ciba.max_expires_in': 120,
          'ciba.expires_in': 120,
          'ciba.min_interval': 10,
          'ciba.max_interval': 10,
          'ciba.poll_interval': 10,
        })
      )
    ).toBeNull();
  });

  describe('against the current document', () => {
    it('compares a changed value with the bounds already saved', () => {
      expect(validateCibaPatch(patch({ 'ciba.min_expires_in': 400 }), { current })).toMatch(
        /ciba\.expires_in \(300\).*below ciba\.min_expires_in \(400\)/
      );
      expect(
        validateCibaPatch(patch({ 'ciba.max_interval': 5 }), {
          current: { ...current, 'ciba.poll_interval': 10 },
        })
      ).toMatch(/ciba\.poll_interval \(10\).*above ciba\.max_interval \(5\)/);
      expect(validateCibaPatch(patch({ 'ciba.expires_in': 600 }), { current })).toBeNull();
      expect(
        validateCibaPatch(patch({ 'ciba.max_expires_in': 90 }), {
          current: { ...current, 'ciba.min_expires_in': 100, 'ciba.expires_in': 100 },
        })
      ).toMatch(/min_expires_in \(100\).*max_expires_in \(90\)/);
    });

    it('accepts a patch that moves a value and its bounds together', () => {
      expect(
        validateCibaPatch(patch({ 'ciba.min_expires_in': 400, 'ciba.expires_in': 450 }), {
          current,
        })
      ).toBeNull();
    });

    it('counts a cleared key as its default where nothing says what it inherits', () => {
      const saved = { ...current, 'ciba.max_interval': 120, 'ciba.poll_interval': 60 };
      expect(
        validateCibaPatch(patch({}, { clear: ['ciba.max_interval'] }), { current: saved })
      ).toBeNull();
      // The saved minimum of 10 would refuse a poll interval of 2; cleared, it is the default 2
      const withMinimum = { ...saved, 'ciba.min_interval': 10, 'ciba.poll_interval': 10 };
      expect(
        validateCibaPatch(patch({ 'ciba.poll_interval': 2 }), { current: withMinimum })
      ).toMatch(/below ciba\.min_interval \(10\)/);
      expect(
        validateCibaPatch(patch({ 'ciba.poll_interval': 2 }, { clear: ['ciba.min_interval'] }), {
          current: withMinimum,
        })
      ).toBeNull();
    });

    describe('a cleared key takes what it inherits', () => {
      it('accepts a clear that the inherited value makes consistent', () => {
        // CIBA_DEFAULT_INTERVAL=30 in the environment: clearing the saved 60 leaves 30, which
        // fits [20, 60]. As the default 5 it would be below the saved minimum of 20.
        const saved = {
          ...current,
          'ciba.min_interval': 20,
          'ciba.poll_interval': 60,
          'ciba.max_interval': 60,
        };
        const patchBody = patch({}, { clear: ['ciba.poll_interval'] });
        expect(validateCibaPatch(patchBody, { current: saved })).toMatch(
          /below ciba\.min_interval/
        );
        expect(
          validateCibaPatch(patchBody, {
            current: saved,
            inherited: { 'ciba.poll_interval': 30 },
          })
        ).toBeNull();
      });

      it('refuses a clear that the inherited value makes inconsistent', () => {
        // CIBA_MAX_INTERVAL=10 in the environment: clearing the saved 60 leaves 10, below the
        // saved poll interval of 20. Against the default 60 it would pass.
        const saved = { ...current, 'ciba.poll_interval': 20, 'ciba.max_interval': 60 };
        const patchBody = patch({}, { clear: ['ciba.max_interval'] });
        expect(validateCibaPatch(patchBody, { current: saved })).toBeNull();
        expect(
          validateCibaPatch(patchBody, { current: saved, inherited: { 'ciba.max_interval': 10 } })
        ).toMatch(/poll_interval \(20\).*above ciba\.max_interval \(10\)/);
      });

      it('falls back to the default for a key the inherited values do not hold', () => {
        const saved = { ...current, 'ciba.poll_interval': 50, 'ciba.max_interval': 60 };
        // The default maximum is 60: fine for 50. A saved minimum above it is not.
        expect(
          validateCibaPatch(patch({}, { clear: ['ciba.max_interval'] }), {
            current: saved,
            inherited: {},
          })
        ).toBeNull();
        expect(
          validateCibaPatch(
            patch({ 'ciba.min_expires_in': 90 }, { clear: ['ciba.max_expires_in'] }),
            {
              current: saved,
              inherited: {},
            }
          )
        ).toBeNull();
      });
    });

    it('does not look at bounds the patch does not touch', () => {
      const inconsistent = { ...current, 'ciba.min_interval': 40, 'ciba.max_interval': 10 };
      expect(
        validateCibaPatch(patch({ 'ciba.binding_message_required': true }), {
          current: inconsistent,
        })
      ).toBeNull();
    });
  });

  describe('refuses the whole patch when a key of it would be refused alone', () => {
    it.each([
      [{ set: { 'ciba.min_interval': 6, 'ciba.poll_interval': 6.5 } }, /ciba\.poll_interval/],
      [{ set: { 'ciba.min_interval': 6, 'ciba.poll_interval': '10' } }, /ciba\.poll_interval/],
      [{ set: { 'ciba.min_interval': 6, 'ciba.poll_interval': 61 } }, /ciba\.poll_interval/],
      [{ set: { 'ciba.min_interval': 6, 'ciba.poll_interval': NaN } }, /ciba\.poll_interval/],
      [
        { set: { 'ciba.binding_message_required': 'yes', 'ciba.min_interval': 6 } },
        /binding_message_required/,
      ],
      [{ set: { 'ciba.min_interval': 6, 'ciba.nope': 1 } }, /ciba\.nope/],
      [
        {
          set: { 'ciba.min_interval': 6, 'ciba.poll_interval': 10 },
          clear: ['ciba.poll_interval'],
        },
        /ciba\.poll_interval.*more than one operation/,
      ],
      [
        { set: { 'ciba.min_interval': 6 }, disable: ['ciba.min_interval'] },
        /more than one operation/,
      ],
      [
        { set: { 'ciba.min_interval': 6 }, disable: ['ciba.max_interval'] },
        /ciba\.max_interval cannot be disabled/,
      ],
    ] as Array<[{ set?: Record<string, unknown>; clear?: string[]; disable?: string[] }, RegExp]>)(
      '%j',
      (body, message) => {
        expect(validateCibaPatch({ ifMatch: '', ...body }, { current })).toMatch(message);
      }
    );

    it('accepts a fractional ciba.push_notification_timeout_ms: that setting does not require a whole number', () => {
      expect(
        validateCibaPatch(patch({ 'ciba.push_notification_timeout_ms': 2500.5 }), { current })
      ).toBeNull();
    });

    it.each([
      ['ciba.slow_down_increment', 5.5],
      ['ciba.max_poll_count', 100.5],
      ['ciba.ping_notification_timeout_ms', 2500.5],
    ])('refuses a fractional %s: the setting requires a whole number', (key, value) => {
      expect(validateCibaPatch(patch({ [key]: value }), { current })).toMatch(
        new RegExp(`${key.replace('.', '\\.')} must be a whole number`)
      );
    });

    it.each([
      ['ciba.slow_down_increment', 4],
      ['ciba.slow_down_increment', 1],
      ['ciba.slow_down_increment', 31],
      ['ciba.slow_down_increment', Infinity],
      ['ciba.max_poll_count', 9],
      ['ciba.max_poll_count', 501],
      ['ciba.ping_notification_timeout_ms', 999],
      ['ciba.ping_notification_timeout_ms', 30001],
      ['ciba.ping_notification_timeout_ms', NaN],
    ])('checks the range and finiteness of %s = %s', (key, value) => {
      expect(validateCibaPatch(patch({ [key]: value }), { current })).toContain(key);
    });

    it.each([
      ['ciba.slow_down_increment', 5],
      ['ciba.slow_down_increment', 30],
      ['ciba.max_poll_count', 10],
      ['ciba.max_poll_count', 500],
      ['ciba.ping_notification_timeout_ms', 1000],
      ['ciba.ping_notification_timeout_ms', 30000],
    ])('accepts %s = %s, on the edge of its range', (key, value) => {
      expect(validateCibaPatch(patch({ [key]: value }), { current })).toBeNull();
    });

    it('accepts the user code switch on, off, and disabled, independent of the other keys', () => {
      expect(validateCibaPatch(patch({ 'ciba.user_code_enabled': true }), { current })).toBeNull();
      expect(validateCibaPatch(patch({ 'ciba.user_code_enabled': false }), { current })).toBeNull();
      expect(validateCibaPatch(patch({}, { disable: ['ciba.user_code_enabled'] }))).toBeNull();
      expect(validateCibaPatch(patch({ 'ciba.user_code_enabled': 'yes' }), { current })).toMatch(
        /user_code_enabled must be true or false/
      );
    });

    it('does not tie the slow_down increment or the ping timeout to the interval bounds', () => {
      const tight = { ...current, 'ciba.max_interval': 5, 'ciba.poll_interval': 5 };
      expect(
        validateCibaPatch(
          patch({ 'ciba.slow_down_increment': 30, 'ciba.ping_notification_timeout_ms': 30000 }),
          { current: tight }
        )
      ).toBeNull();
    });

    it('refuses a fractional value of a setting that requires a whole number', () => {
      for (const key of [
        'ciba.poll_interval',
        'ciba.expires_in',
        'ciba.max_binding_message_length',
      ]) {
        expect(validateCibaPatch(patch({ [key]: 6.5 + 60 }), { current }), key).toContain(key);
      }
      expect(validateCibaPatch(patch({ 'ciba.poll_interval': 6.5 }), { current })).toMatch(
        /ciba\.poll_interval must be a whole number/
      );
    });

    it.each([
      'ciba.auth_request_ttl',
      'ciba.notifier_default_timeout_ms',
      'ciba.notifier_max_timeout_ms',
      'ciba.notifier_retry_delay_base_ms',
    ])('refuses the retired %s as not a CIBA setting, whatever the operation', (key) => {
      expect(validateCibaPatch(patch({ [key]: 1000 }), { current })).toBe(
        `${key} is not a CIBA setting`
      );
      expect(validateCibaPatch(patch({}, { clear: [key] }), { current })).toBe(
        `${key} is not a CIBA setting`
      );
      expect(validateCibaPatch(patch({}, { disable: [key] }), { current })).toBe(
        `${key} is not a CIBA setting`
      );
    });

    it('still accepts a boolean disabled', () => {
      expect(
        validateCibaPatch(patch({}, { disable: ['ciba.binding_message_required'] }))
      ).toBeNull();
    });
  });
});

describe('validateCategoryPatch for ciba', () => {
  it('runs the CIBA checks (patch alone) where there is no current document', () => {
    expect(
      validateCategoryPatch('ciba', patch({ 'ciba.min_interval': 30, 'ciba.max_interval': 10 }))
    ).toMatch(/min_interval/);
    expect(validateCategoryPatch('ciba', patch({ 'ciba.expires_in': 120 }))).toBeNull();
  });
});
