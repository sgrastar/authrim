import { describe, expect, it } from 'vitest';
import { parsePlatformSettingsPatch } from '../routes/settings-v2/platform-patch-guards';

const KEY = 'identity_mapping.oidc_default_set_id';

describe('platform PATCH guard presence before sanitization', () => {
  it.each([undefined, null, '', ' ', 1, false, [], {}])('rejects expected_version %j', (value) => {
    expect(
      parsePlatformSettingsPatch({ expected_version: value, clear: [KEY] }, 'identity-mapping')
    ).toMatchObject({ ok: false });
  });

  it.each([
    undefined,
    null,
    -1,
    0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '0',
    false,
    [],
    {},
  ])('rejects expected_following %j even when explicitly undefined', (value) => {
    expect(
      parsePlatformSettingsPatch(
        { ifMatch: 'version', expected_following: value, clear: [KEY] },
        'identity-mapping'
      )
    ).toMatchObject({ ok: false });
  });

  it.each([undefined, null, 42, false, '', 'another-version'])(
    'rejects an incompatible ifMatch %j',
    (ifMatch) => {
      expect(
        parsePlatformSettingsPatch(
          { ifMatch, expected_version: 'version', clear: [KEY] },
          'identity-mapping'
        )
      ).toMatchObject({ ok: false });
    }
  );

  it('treats zero as a present guard and aliases the version without passing guard fields to SettingsManager', () => {
    expect(
      parsePlatformSettingsPatch(
        { expected_version: 'version', expected_following: 0, clear: [KEY] },
        'identity-mapping'
      )
    ).toEqual({
      ok: true,
      body: { ifMatch: 'version', set: undefined, clear: [KEY], disable: undefined },
      expectedFollowing: 0,
    });
  });

  it('does not interpret inherited guard properties as a supplied guard', () => {
    const raw: unknown = Object.assign(Object.create({ expected_following: 'invalid' }) as object, {
      ifMatch: 'version',
      clear: [KEY],
    });
    expect(parsePlatformSettingsPatch(raw, 'identity-mapping')).toMatchObject({
      ok: true,
      body: { ifMatch: 'version' },
    });
  });
});
