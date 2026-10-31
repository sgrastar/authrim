import { describe, expect, it } from 'vitest';
import {
  categoryPatchNeedsState,
  validateCategoryPatch,
  validateCategoryPatchAt,
  validateDeviceFlowPatch,
  validateSettingValue,
} from '../routes/settings-v2/patch-validation';

const patch = (
  set: Record<string, unknown>,
  extra: { clear?: string[]; disable?: string[] } = {}
) => ({
  ifMatch: '',
  set,
  ...extra,
});

/** The effective values of a tenant with nothing saved. */
const current = {
  'device_flow.expires_in': 600,
  'device_flow.min_expires_in': 300,
  'device_flow.max_expires_in': 1800,
  'device_flow.poll_interval': 5,
  'device_flow.min_interval': 5,
  'device_flow.max_interval': 60,
  'device_flow.slow_down_increment': 5,
  'device_flow.max_poll_count': 120,
};

describe('validateDeviceFlowPatch', () => {
  it('accepts a patch with no bounds in it', () => {
    expect(validateDeviceFlowPatch(patch({ 'device_flow.max_poll_count': 200 }))).toBeNull();
    expect(validateDeviceFlowPatch(patch({ 'device_flow.slow_down_increment': 10 }))).toBeNull();
    expect(validateDeviceFlowPatch(patch({ 'device_flow.user_code_length': 8 }))).toBeNull();
    expect(
      validateDeviceFlowPatch(patch({ 'device_flow.user_code_charset': 'NUMERIC' }))
    ).toBeNull();
  });

  it.each([
    [
      { 'device_flow.min_expires_in': 900, 'device_flow.max_expires_in': 400 },
      /min_expires_in.*max_expires_in/,
    ],
    [
      { 'device_flow.min_interval': 20, 'device_flow.max_interval': 10 },
      /min_interval.*max_interval/,
    ],
    [
      { 'device_flow.min_expires_in': 700, 'device_flow.expires_in': 400 },
      /expires_in.*below.*min_expires_in/,
    ],
    [
      { 'device_flow.max_expires_in': 400, 'device_flow.expires_in': 500 },
      /expires_in.*above.*max_expires_in/,
    ],
    [
      { 'device_flow.min_interval': 10, 'device_flow.poll_interval': 6 },
      /poll_interval.*below.*min_interval/,
    ],
    [
      { 'device_flow.max_interval': 10, 'device_flow.poll_interval': 20 },
      /poll_interval.*above.*max_interval/,
    ],
  ])('refuses %j within the patch alone', (set, message) => {
    expect(validateDeviceFlowPatch(patch(set))).toMatch(message);
  });

  it('accepts equal bounds and values on a bound', () => {
    expect(
      validateDeviceFlowPatch(
        patch({
          'device_flow.min_expires_in': 400,
          'device_flow.max_expires_in': 400,
          'device_flow.expires_in': 400,
          'device_flow.min_interval': 10,
          'device_flow.max_interval': 10,
          'device_flow.poll_interval': 10,
        })
      )
    ).toBeNull();
  });

  describe('against the current document', () => {
    it('compares a changed value with the bounds already saved', () => {
      expect(
        validateDeviceFlowPatch(patch({ 'device_flow.min_expires_in': 700 }), { current })
      ).toMatch(/device_flow\.expires_in \(600\).*below device_flow\.min_expires_in \(700\)/);
      expect(
        validateDeviceFlowPatch(patch({ 'device_flow.max_interval': 5 }), {
          current: { ...current, 'device_flow.poll_interval': 10 },
        })
      ).toMatch(/device_flow\.poll_interval \(10\).*above device_flow\.max_interval \(5\)/);
      expect(
        validateDeviceFlowPatch(patch({ 'device_flow.expires_in': 900 }), { current })
      ).toBeNull();
    });

    it('refuses a poll interval below the default lower bound of 5 until the bound is lowered', () => {
      expect(
        validateDeviceFlowPatch(patch({ 'device_flow.poll_interval': 2 }), { current })
      ).toMatch(/poll_interval \(2\).*below device_flow\.min_interval \(5\)/);
      expect(
        validateDeviceFlowPatch(
          patch({ 'device_flow.poll_interval': 2, 'device_flow.min_interval': 1 }),
          { current }
        )
      ).toBeNull();
    });

    it('accepts a patch that moves a value and its bounds together', () => {
      expect(
        validateDeviceFlowPatch(
          patch({ 'device_flow.min_expires_in': 700, 'device_flow.expires_in': 750 }),
          { current }
        )
      ).toBeNull();
    });

    it('does not tie the slow_down increment or the poll count to the interval bounds', () => {
      const tight = { ...current, 'device_flow.max_interval': 5, 'device_flow.poll_interval': 5 };
      expect(
        validateDeviceFlowPatch(
          patch({ 'device_flow.slow_down_increment': 30, 'device_flow.max_poll_count': 10 }),
          { current: tight }
        )
      ).toBeNull();
    });

    it('does not look at bounds the patch does not touch', () => {
      const inconsistent = {
        ...current,
        'device_flow.min_interval': 40,
        'device_flow.max_interval': 10,
      };
      expect(
        validateDeviceFlowPatch(patch({ 'device_flow.max_poll_count': 200 }), {
          current: inconsistent,
        })
      ).toBeNull();
    });

    describe('a cleared key takes what it inherits', () => {
      it('accepts a clear that the inherited value makes consistent', () => {
        // DEVICE_FLOW_DEFAULT_INTERVAL=30 in the environment: clearing the saved 60 leaves 30,
        // which fits [20, 60]. As the default 5 it would be below the saved minimum of 20.
        const saved = {
          ...current,
          'device_flow.min_interval': 20,
          'device_flow.poll_interval': 60,
          'device_flow.max_interval': 60,
        };
        const body = patch({}, { clear: ['device_flow.poll_interval'] });
        expect(validateDeviceFlowPatch(body, { current: saved })).toMatch(
          /below device_flow\.min_interval/
        );
        expect(
          validateDeviceFlowPatch(body, {
            current: saved,
            inherited: { 'device_flow.poll_interval': 30 },
          })
        ).toBeNull();
      });

      it('refuses a clear that the inherited value makes inconsistent', () => {
        const saved = {
          ...current,
          'device_flow.poll_interval': 20,
          'device_flow.max_interval': 60,
        };
        const body = patch({}, { clear: ['device_flow.max_interval'] });
        expect(validateDeviceFlowPatch(body, { current: saved })).toBeNull();
        expect(
          validateDeviceFlowPatch(body, {
            current: saved,
            inherited: { 'device_flow.max_interval': 10 },
          })
        ).toMatch(/poll_interval \(20\).*above device_flow\.max_interval \(10\)/);
      });

      it('falls back to the default for a key the inherited values do not hold', () => {
        const saved = {
          ...current,
          'device_flow.poll_interval': 50,
          'device_flow.max_interval': 70,
        };
        // The default maximum is 60: fine for 50
        expect(
          validateDeviceFlowPatch(patch({}, { clear: ['device_flow.max_interval'] }), {
            current: saved,
            inherited: {},
          })
        ).toBeNull();
        // The default minimum is 5: a saved poll interval of 2 would be below it
        expect(
          validateDeviceFlowPatch(patch({}, { clear: ['device_flow.min_interval'] }), {
            current: { ...saved, 'device_flow.min_interval': 1, 'device_flow.poll_interval': 2 },
            inherited: {},
          })
        ).toMatch(/poll_interval \(2\).*below device_flow\.min_interval \(5\)/);
      });
    });
  });

  describe('for a client', () => {
    // What the client has, with the tenant's values as what each key inherits
    const tenant = {
      ...current,
      'device_flow.min_expires_in': 400,
      'device_flow.max_expires_in': 900,
      'device_flow.min_interval': 5,
      'device_flow.max_interval': 30,
    };
    const state = { current: tenant, inherited: tenant, scope: 'client' as const };

    it('accepts a lifetime and an interval inside the tenant bounds', () => {
      expect(
        validateDeviceFlowPatch(
          patch({ 'device_flow.expires_in': 450, 'device_flow.poll_interval': 8 }),
          state
        )
      ).toBeNull();
    });

    it('refuses a lifetime and an interval outside the tenant bounds', () => {
      expect(validateDeviceFlowPatch(patch({ 'device_flow.expires_in': 1500 }), state)).toMatch(
        /expires_in \(1500\).*above device_flow\.max_expires_in \(900\)/
      );
      expect(validateDeviceFlowPatch(patch({ 'device_flow.expires_in': 350 }), state)).toMatch(
        /expires_in \(350\).*below device_flow\.min_expires_in \(400\)/
      );
      expect(validateDeviceFlowPatch(patch({ 'device_flow.poll_interval': 45 }), state)).toMatch(
        /poll_interval \(45\).*above device_flow\.max_interval \(30\)/
      );
    });

    it('accepts bounds that narrow the tenant bounds', () => {
      expect(
        validateDeviceFlowPatch(
          patch({
            'device_flow.min_expires_in': 500,
            'device_flow.max_expires_in': 600,
            'device_flow.min_interval': 10,
            'device_flow.max_interval': 20,
            'device_flow.expires_in': 550,
            'device_flow.poll_interval': 15,
          }),
          state
        )
      ).toBeNull();
    });

    it.each([
      [{ 'device_flow.max_expires_in': 1200 }, /max_expires_in \(1200\).*above the tenant's 900/],
      [{ 'device_flow.min_expires_in': 300 }, /min_expires_in \(300\).*below the tenant's 400/],
      [{ 'device_flow.max_interval': 60 }, /max_interval \(60\).*above the tenant's 30/],
      [{ 'device_flow.min_interval': 1 }, /min_interval \(1\).*below the tenant's 5/],
    ])('refuses %j: a client can only narrow the tenant bounds', (set, message) => {
      expect(validateDeviceFlowPatch(patch(set), state)).toMatch(message);
    });

    it('lets the tenant widen what a client may do only for a tenant PATCH', () => {
      // The same bound at the tenant scope is an ordinary change
      expect(
        validateDeviceFlowPatch(patch({ 'device_flow.max_expires_in': 1200 }), {
          current: tenant,
          inherited: current,
          scope: 'tenant',
        })
      ).toBeNull();
    });

    it('takes a cleared key as the tenant value', () => {
      const client = { ...tenant, 'device_flow.max_interval': 20, 'device_flow.poll_interval': 25 };
      // Cleared, the client's maximum is the tenant's 30, which fits its poll interval of 25
      expect(
        validateDeviceFlowPatch(patch({}, { clear: ['device_flow.max_interval'] }), {
          current: { ...client, 'device_flow.poll_interval': 25 },
          inherited: tenant,
          scope: 'client',
        })
      ).toBeNull();
    });
  });

  describe('refuses the whole patch when a key of it would be refused alone', () => {
    it.each([
      [
        { set: { 'device_flow.min_interval': 6, 'device_flow.poll_interval': 6.5 } },
        /device_flow\.poll_interval must be a whole number/,
      ],
      [
        { set: { 'device_flow.min_interval': 6, 'device_flow.poll_interval': '10' } },
        /device_flow\.poll_interval/,
      ],
      [
        { set: { 'device_flow.min_interval': 6, 'device_flow.poll_interval': 61 } },
        /device_flow\.poll_interval/,
      ],
      [
        { set: { 'device_flow.min_interval': 6, 'device_flow.poll_interval': NaN } },
        /device_flow\.poll_interval/,
      ],
      [
        { set: { 'device_flow.min_interval': 6, 'device_flow.nope': 1 } },
        /device_flow\.nope is not a device flow setting/,
      ],
      [
        {
          set: { 'device_flow.min_interval': 6, 'device_flow.poll_interval': 10 },
          clear: ['device_flow.poll_interval'],
        },
        /device_flow\.poll_interval.*more than one operation/,
      ],
      [
        { set: { 'device_flow.min_interval': 6 }, disable: ['device_flow.min_interval'] },
        /more than one operation/,
      ],
      [
        { set: { 'device_flow.min_interval': 6 }, disable: ['device_flow.max_interval'] },
        /device_flow\.max_interval cannot be disabled/,
      ],
      [
        { set: { 'device_flow.min_interval': 6, 'device_flow.user_code_charset': 'HEX' } },
        /device_flow\.user_code_charset must be one of: BASE31, BASE20, NUMERIC/,
      ],
      [
        { set: { 'device_flow.min_interval': 6, 'device_flow.user_code_charset': 5 } },
        /device_flow\.user_code_charset/,
      ],
      [
        { set: { 'device_flow.min_interval': 6, 'device_flow.user_code_length': 3 } },
        /device_flow\.user_code_length/,
      ],
    ] as Array<[{ set?: Record<string, unknown>; clear?: string[]; disable?: string[] }, RegExp]>)(
      '%j',
      (body, message) => {
        expect(validateDeviceFlowPatch({ ifMatch: '', ...body }, { current })).toMatch(message);
      }
    );

    it.each([
      ['device_flow.expires_in', 700.5],
      ['device_flow.min_expires_in', 400.5],
      ['device_flow.max_expires_in', 1000.5],
      ['device_flow.poll_interval', 6.5],
      ['device_flow.min_interval', 5.5],
      ['device_flow.max_interval', 30.5],
      ['device_flow.slow_down_increment', 5.5],
      ['device_flow.max_poll_count', 100.5],
    ])('refuses a fractional %s: the setting requires a whole number', (key, value) => {
      expect(validateDeviceFlowPatch(patch({ [key]: value }), { current })).toBe(
        `${key} must be a whole number`
      );
    });

    it.each([
      ['device_flow.slow_down_increment', 4],
      ['device_flow.slow_down_increment', 1],
      ['device_flow.slow_down_increment', 31],
      ['device_flow.slow_down_increment', Infinity],
      ['device_flow.max_poll_count', 9],
      ['device_flow.max_poll_count', 501],
      ['device_flow.max_expires_in', 3601],
      ['device_flow.max_interval', 301],
      ['device_flow.max_interval', 4],
      ['device_flow.expires_in', 299],
      ['device_flow.expires_in', 1801],
    ])('checks the range and finiteness of %s = %s', (key, value) => {
      expect(validateDeviceFlowPatch(patch({ [key]: value }), { current })).toContain(key);
    });

    it.each([
      ['device_flow.slow_down_increment', 5],
      ['device_flow.slow_down_increment', 30],
      ['device_flow.max_poll_count', 10],
      ['device_flow.max_poll_count', 500],
      ['device_flow.max_expires_in', 3600],
      ['device_flow.max_interval', 300],
    ])('accepts %s = %s, on the edge of its range', (key, value) => {
      expect(validateDeviceFlowPatch(patch({ [key]: value }), { current })).toBeNull();
    });
  });
});

describe('device flow checks outside the PATCH route state', () => {
  it('validateCategoryPatch checks the values the patch holds', () => {
    expect(
      validateCategoryPatch(
        'device-flow',
        patch({ 'device_flow.min_interval': 20, 'device_flow.max_interval': 10 })
      )
    ).toMatch(/min_interval/);
    expect(
      validateCategoryPatch('device-flow', patch({ 'device_flow.max_interval': 10 }))
    ).toBeNull();
  });

  it('validateSettingValue refuses a value one save would refuse', () => {
    const env = {} as never;
    expect(
      validateSettingValue('device-flow', 'tenant', 'device_flow.slow_down_increment', 4, env)
    ).toMatch(/slow_down_increment/);
    expect(
      validateSettingValue('device-flow', 'client', 'device_flow.slow_down_increment', 10, env)
    ).toBeNull();
  });

  it('reads the state for device-flow and ciba only', () => {
    expect(categoryPatchNeedsState('device-flow')).toBe(true);
    expect(categoryPatchNeedsState('ciba')).toBe(true);
    expect(categoryPatchNeedsState('oauth')).toBe(false);
  });

  it('validateCategoryPatchAt uses the state and the scope', () => {
    const state = {
      current: { ...current, 'device_flow.max_interval': 30 },
      inherited: { ...current, 'device_flow.max_interval': 30 },
    };
    const body = patch({ 'device_flow.max_interval': 60 });
    expect(validateCategoryPatchAt('device-flow', 'tenant', body, state)).toBeNull();
    expect(validateCategoryPatchAt('device-flow', 'client', body, state)).toMatch(/tenant's 30/);
    // without state the relations of the PATCH alone are all there is
    expect(validateCategoryPatchAt('device-flow', 'client', body, null)).toBeNull();
    // other categories are untouched
    expect(validateCategoryPatchAt('oauth', 'tenant', patch({}), null)).toBeNull();
  });
});

describe('the user code charset and length', () => {
  const charsetKey = 'device_flow.user_code_charset';
  const lengthKey = 'device_flow.user_code_length';
  /** The effective values of a tenant with nothing saved: BASE31 x 8. */
  const base = { ...current, [charsetKey]: 'BASE31', [lengthKey]: 8 };

  describe('are checked together on the pair the save leaves', () => {
    // [charset, shortest allowed length]
    const floors: Array<[string, number]> = [
      ['BASE31', 7],
      ['BASE20', 8],
      ['NUMERIC', 11],
    ];

    describe.each(floors)('%s', (charset, shortest) => {
      it.each(Array.from({ length: 13 }, (_, index) => index + 4))(
        'both keys in one patch: length %i',
        (length) => {
          const problem = validateDeviceFlowPatch(
            patch({ [charsetKey]: charset, [lengthKey]: length }),
            { current: base }
          );
          if (length >= shortest) expect(problem).toBeNull();
          else expect(problem).toContain(`at least ${shortest} characters with ${charset}`);
        }
      );
    });

    it('refuses NUMERIC with 10 digits, naming the minimum for the charset', () => {
      expect(
        validateDeviceFlowPatch(patch({ [charsetKey]: 'NUMERIC', [lengthKey]: 10 }), {
          current: base,
        })
      ).toMatch(/user_code_length \(10\).*NUMERIC.*34 bits.*33\.2 bits.*at least 11 characters/);
    });

    it('also without any state (imports and profiles), when the patch holds both keys', () => {
      expect(validateDeviceFlowPatch(patch({ [charsetKey]: 'NUMERIC', [lengthKey]: 10 }))).toMatch(
        /at least 11 characters with NUMERIC/
      );
      expect(
        validateDeviceFlowPatch(patch({ [charsetKey]: 'NUMERIC', [lengthKey]: 11 }))
      ).toBeNull();
    });

    it('a charset alone is checked against the saved length', () => {
      // the tenant has length 8 saved: NUMERIC needs 11
      expect(
        validateDeviceFlowPatch(patch({ [charsetKey]: 'NUMERIC' }), { current: base })
      ).toMatch(/user_code_length \(8\).*at least 11 characters with NUMERIC/);
      // a longer saved length makes it fine
      expect(
        validateDeviceFlowPatch(patch({ [charsetKey]: 'NUMERIC' }), {
          current: { ...base, [lengthKey]: 12 },
        })
      ).toBeNull();
      expect(
        validateDeviceFlowPatch(patch({ [charsetKey]: 'BASE20' }), { current: base })
      ).toBeNull();
    });

    it('a length alone is checked against the saved charset (the default when none is saved)', () => {
      expect(validateDeviceFlowPatch(patch({ [lengthKey]: 4 }), { current: base })).toMatch(
        /at least 7 characters with BASE31/
      );
      expect(validateDeviceFlowPatch(patch({ [lengthKey]: 7 }), { current: base })).toBeNull();
      // a state with no value for the charset: the default charset counts
      expect(validateDeviceFlowPatch(patch({ [lengthKey]: 6 }), { current })).toMatch(
        /at least 7 characters with BASE31/
      );
      expect(
        validateDeviceFlowPatch(patch({ [lengthKey]: 10 }), {
          current: { ...base, [charsetKey]: 'NUMERIC', [lengthKey]: 12 },
        })
      ).toMatch(/at least 11 characters with NUMERIC/);
    });

    it('moving both keys at once is fine, one at a time is refused', () => {
      const saved = { ...base, [charsetKey]: 'NUMERIC', [lengthKey]: 12 };
      // BASE31 x 4 in one step
      expect(
        validateDeviceFlowPatch(patch({ [charsetKey]: 'BASE31', [lengthKey]: 7 }), {
          current: saved,
        })
      ).toBeNull();
      // the charset alone keeps length 12: fine for every charset
      expect(
        validateDeviceFlowPatch(patch({ [charsetKey]: 'BASE20' }), { current: saved })
      ).toBeNull();
      // the length alone falls under the NUMERIC floor
      expect(validateDeviceFlowPatch(patch({ [lengthKey]: 10 }), { current: saved })).toMatch(
        /at least 11 characters with NUMERIC/
      );
    });
  });

  describe('a cleared key counts as what it inherits', () => {
    it('refuses a clear whose inherited value makes the pair too short', () => {
      // NUMERIC x 12 saved; the length is cleared and the environment says 8
      const saved = { ...base, [charsetKey]: 'NUMERIC', [lengthKey]: 12 };
      const problem = validateDeviceFlowPatch(
        { ifMatch: '', clear: [lengthKey] },
        { current: saved, inherited: { [lengthKey]: 8 } }
      );
      expect(problem).toMatch(/user_code_length \(8\).*at least 11 characters with NUMERIC/);
    });

    it('refuses clearing the charset while a short length is saved and the default needs more', () => {
      // BASE20 x 8 saved, the environment inherits NUMERIC: NUMERIC x 8 is below the floor
      const saved = { ...base, [charsetKey]: 'BASE20', [lengthKey]: 8 };
      expect(
        validateDeviceFlowPatch(
          { ifMatch: '', clear: [charsetKey] },
          { current: saved, inherited: { [charsetKey]: 'NUMERIC' } }
        )
      ).toMatch(/NUMERIC/);
    });

    it('falls back to the defaults for what is inherited from nowhere', () => {
      const saved = { ...base, [charsetKey]: 'NUMERIC', [lengthKey]: 12 };
      // clearing both leaves BASE31 x 8
      expect(
        validateDeviceFlowPatch({ ifMatch: '', clear: [charsetKey, lengthKey] }, { current: saved })
      ).toBeNull();
      // clearing the length alone leaves NUMERIC x 8 (the default length)
      expect(
        validateDeviceFlowPatch({ ifMatch: '', clear: [lengthKey] }, { current: saved })
      ).toMatch(/at least 11 characters with NUMERIC/);
    });

    it('a set value beats the inherited one', () => {
      const saved = { ...base, [charsetKey]: 'NUMERIC', [lengthKey]: 12 };
      expect(
        validateDeviceFlowPatch(
          { ifMatch: '', set: { [lengthKey]: 11 }, clear: [charsetKey] },
          { current: saved, inherited: { [charsetKey]: 'NUMERIC' } }
        )
      ).toBeNull();
    });
  });

  describe('the whole patch is refused, so a refusal saves nothing of it', () => {
    it('a pair below the floor refuses the other keys of the patch too', () => {
      expect(
        validateDeviceFlowPatch(
          patch({ [charsetKey]: 'NUMERIC', [lengthKey]: 10, 'device_flow.max_poll_count': 200 }),
          { current: base }
        )
      ).toMatch(/user_code_length/);
    });

    it('a user code key the patch repeats or disables is refused', () => {
      expect(
        validateDeviceFlowPatch(
          { ifMatch: '', set: { [lengthKey]: 12 }, clear: [lengthKey] },
          { current: base }
        )
      ).toMatch(/more than one operation/);
      expect(
        validateDeviceFlowPatch({ ifMatch: '', disable: [charsetKey] }, { current: base })
      ).toMatch(/cannot be disabled/);
    });

    it.each([
      [{ [charsetKey]: 'HEX' }, /must be one of: BASE31, BASE20, NUMERIC/],
      [{ [charsetKey]: 'base31' }, /must be one of/],
      [{ [charsetKey]: 31 }, /must be one of/],
      [{ [lengthKey]: 3 }, /between 4 and 16/],
      [{ [lengthKey]: 17 }, /between 4 and 16/],
      [{ [lengthKey]: 8.5 }, /must be a whole number/],
      [{ [lengthKey]: '8' }, /must be a number/],
    ])('value %j', (set, message) => {
      expect(validateDeviceFlowPatch(patch(set), { current: base })).toMatch(message);
    });
  });

  describe('for a client', () => {
    it.each([charsetKey, lengthKey])('refuses %s: it is a tenant setting', (key) => {
      const value = key === charsetKey ? 'BASE31' : 8;
      expect(
        validateDeviceFlowPatch(patch({ [key]: value }), { current: base, scope: 'client' })
      ).toMatch(/is a tenant setting: a client cannot set it/);
    });

    it('refuses clearing them too, and accepts the tenant PATCH of the same body', () => {
      expect(
        validateDeviceFlowPatch(
          { ifMatch: '', clear: [lengthKey] },
          { current: base, scope: 'client' }
        )
      ).toMatch(/tenant setting/);
      expect(
        validateDeviceFlowPatch(patch({ [lengthKey]: 12 }), { current: base, scope: 'tenant' })
      ).toBeNull();
    });

    it('does not block the other keys of a client', () => {
      expect(
        validateDeviceFlowPatch(patch({ 'device_flow.max_poll_count': 200 }), {
          current: base,
          scope: 'client',
        })
      ).toBeNull();
    });
  });

  it('validateSettingValue (imports) keeps a pair the patch holds above the floor', () => {
    const env = {} as never;
    expect(validateSettingValue('device-flow', 'tenant', charsetKey, 'NUMERIC', env)).toBeNull();
    expect(validateSettingValue('device-flow', 'tenant', charsetKey, 'HEX', env)).toMatch(
      /must be one of/
    );
    expect(
      validateCategoryPatch('device-flow', patch({ [charsetKey]: 'NUMERIC', [lengthKey]: 10 }))
    ).toMatch(/at least 11/);
  });
});
