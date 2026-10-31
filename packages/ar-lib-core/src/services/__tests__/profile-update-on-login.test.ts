import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE_UPDATE_FIELDS,
  parseProfileUpdateFields,
  profileUpdateFieldsProblem,
  profileValuesFromClaims,
  resolveProfileUpdateFields,
} from '../profile-update-on-login';

describe('profile update on login', () => {
  it('takes a list of the profile fields, each once', () => {
    expect(profileUpdateFieldsProblem(['name', 'locale'])).toBeNull();
    expect(profileUpdateFieldsProblem([])).toBeNull();
  });

  it.each([
    ['not a list', 'name,locale'],
    ['a contact', ['email']],
    ['an identifier', ['preferred_username']],
    ['an account state', ['active']],
    ['a field twice', ['name', 'name']],
    ['a non-string', [1]],
  ])('refuses %s', (_label, value) => {
    expect(profileUpdateFieldsProblem(value)).not.toBeNull();
  });

  it('reads a saved list, as JSON text too', () => {
    expect(parseProfileUpdateFields('["nickname"]')).toEqual(['nickname']);
    expect(parseProfileUpdateFields(['nickname'])).toEqual(['nickname']);
    expect(parseProfileUpdateFields('not json')).toBeNull();
  });

  it("takes an IdP's own list over the tenant default, an empty one included", () => {
    expect(resolveProfileUpdateFields(['name'], ['locale'])).toEqual(['locale']);
    expect(resolveProfileUpdateFields(['name'], [])).toEqual([]);
    expect(resolveProfileUpdateFields(['name'], null)).toEqual(['name']);
    expect(resolveProfileUpdateFields(['name'])).toEqual(['name']);
  });

  it('updates nothing for a list that cannot be read', () => {
    expect(resolveProfileUpdateFields(['email'])).toEqual([]);
    expect(resolveProfileUpdateFields(['name'], 'garbage')).toEqual([]);
  });

  it('keeps what logins have always updated as the default', () => {
    expect(DEFAULT_PROFILE_UPDATE_FIELDS).toEqual([
      'name',
      'given_name',
      'family_name',
      'picture',
      'locale',
    ]);
  });

  it('takes only the chosen fields the claims carry as strings', () => {
    expect(
      profileValuesFromClaims(
        { name: 'Alice', nickname: 7, locale: 'ja', email: 'a@example.com' },
        ['name', 'nickname', 'picture']
      )
    ).toEqual({ name: 'Alice' });
  });
});
