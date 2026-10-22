import { describe, expect, it } from 'vitest';
import {
  institutionDisplayNamesProblem,
  institutionFromSettings,
  institutionScopeProblem,
  institutionScopesProblem,
  readInstitutionDisplayNames,
  readInstitutionScopes,
} from '../tenant-institution';
import {
  MAX_INSTITUTION_DISPLAY_NAMES,
  MAX_INSTITUTION_NAME_LENGTH,
  MAX_INSTITUTION_SCOPES,
} from '../../types/settings/institution';

describe('one scope', () => {
  it.each(['example.ac.jp', 'med.example.ac.jp', 'example.org', 'xn--r8jz45g.jp', 'a-b.example'])(
    'accepts the domain name %s',
    (scope) => {
      expect(institutionScopeProblem(scope)).toBeNull();
    }
  );

  it.each([
    ['', 'empty'],
    ['*.example.ac.jp', 'wildcard'],
    ['*', 'wildcard'],
    ['Example.AC.JP', 'uppercase'],
    ['example', 'one label'],
    ['example.ac.jp.', 'trailing dot'],
    ['.example.ac.jp', 'leading dot'],
    ['example..ac.jp', 'empty label'],
    ['-example.ac.jp', 'label starts with a hyphen'],
    ['example-.ac.jp', 'label ends with a hyphen'],
    ['exam_ple.ac.jp', 'underscore'],
    ['example.ac.jp:8080', 'port'],
    ['example.ac.jp/path', 'path'],
    ['user@example.ac.jp', 'scoped value'],
    ['https://example.ac.jp', 'URL'],
    ['192.168.0.1', 'IP address'],
    ['例え.jp', 'not in punycode form'],
    ['exa mple.ac.jp', 'space'],
    [`${'a'.repeat(64)}.example`, 'label of 64'],
    [`${'a.'.repeat(130)}jp`, 'longer than 253'],
  ])('refuses %j (%s)', (scope) => {
    expect(institutionScopeProblem(scope)).toEqual(expect.any(String));
  });
});

describe('institution.scopes as saved', () => {
  it('accepts one to the most distinct scopes, padding around the commas allowed', () => {
    expect(institutionScopesProblem('example.ac.jp')).toBeNull();
    expect(
      institutionScopesProblem('example.ac.jp, med.example.ac.jp ,law.example.ac.jp')
    ).toBeNull();
    const most = Array.from({ length: MAX_INSTITUTION_SCOPES }, (_, i) => `s${i}.example.ac.jp`);
    expect(institutionScopesProblem(most.join(','))).toBeNull();
  });

  it.each([
    ['an empty list', ''],
    ['only blanks', '  '],
    ['a list with an empty entry', 'example.ac.jp,,med.example.ac.jp'],
    ['a trailing comma', 'example.ac.jp,'],
    ['a repeat', 'example.ac.jp,example.ac.jp'],
    ['a wildcard', 'example.ac.jp,*.example.ac.jp'],
    ['an uppercase domain', 'example.ac.jp,MED.example.ac.jp'],
    ['not a string', ['example.ac.jp']],
    ['a number', 1],
    ['null', null],
    [
      'too many',
      Array.from({ length: MAX_INSTITUTION_SCOPES + 1 }, (_, i) => `s${i}.example.ac.jp`).join(','),
    ],
  ])('refuses %s', (_name, value) => {
    expect(institutionScopesProblem(value)).toEqual(expect.any(String));
  });

  it('keeps what a refusal shows short and free of control characters', () => {
    const problem = institutionScopesProblem(`${'x'.repeat(200)}\u0000\n`);
    expect(problem!.length).toBeLessThan(200);
    expect(problem).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('the scopes as runtime reads them', () => {
  it('has none where nothing is saved', () => {
    for (const unset of [undefined, null, '']) {
      expect(readInstitutionScopes(unset)).toEqual({ state: 'unset' });
    }
  });

  it('takes the first scope as the default', () => {
    expect(readInstitutionScopes('example.ac.jp, med.example.ac.jp')).toEqual({
      state: 'set',
      scopes: ['example.ac.jp', 'med.example.ac.jp'],
      defaultScope: 'example.ac.jp',
    });
  });

  it('is invalid, never unset, for anything saved that is not a valid list', () => {
    for (const saved of [
      '*.example.ac.jp',
      'Example.AC.JP',
      ' ',
      false,
      0,
      {},
      ['example.ac.jp'],
    ]) {
      expect(readInstitutionScopes(saved), JSON.stringify(saved)).toEqual({ state: 'invalid' });
    }
  });
});

describe('institution.display_names as saved', () => {
  const names = (value: unknown) => JSON.stringify(value);

  it('accepts a name in at least Japanese and English, and in more languages', () => {
    expect(
      institutionDisplayNamesProblem(names({ ja: '例大学', en: 'Example University' }))
    ).toBeNull();
    expect(
      institutionDisplayNamesProblem(
        names({
          ja: '例大学',
          en: 'Example University',
          'en-gb': 'Example University',
          zh: '例大学',
        })
      )
    ).toBeNull();
  });

  it.each([
    ['not JSON', 'Example University'],
    ['not a string', { ja: 'x', en: 'y' }],
    ['an array', names(['a', 'b'])],
    ['null', 'null'],
    ['an empty object', names({})],
    ['no Japanese', names({ en: 'Example University' })],
    ['no English', names({ ja: '例大学' })],
    ['an empty name', names({ ja: '例大学', en: '' })],
    ['a name that is not a string', names({ ja: '例大学', en: 1 })],
    ['a padded name', names({ ja: '例大学', en: ' Example University' })],
    ['a name with a control character', names({ ja: '例大学', en: 'Example\nUniversity' })],
    [
      'a name that is too long',
      names({ ja: '例大学', en: 'x'.repeat(MAX_INSTITUTION_NAME_LENGTH + 1) }),
    ],
    ['a language that is not a tag', names({ ja: '例大学', en: 'Example', 'not a tag': 'x' })],
    ['an uppercase language', names({ ja: '例大学', en: 'Example', EN: 'x' })],
    [
      'too many languages',
      names({
        ja: 'x',
        en: 'y',
        ...Object.fromEntries(
          Array.from({ length: MAX_INSTITUTION_DISPLAY_NAMES }, (_, i) => [
            `x${String.fromCharCode(97 + i)}`,
            'n',
          ])
        ),
      }),
    ],
  ])('refuses %s', (_name, value) => {
    expect(institutionDisplayNamesProblem(value)).toEqual(expect.any(String));
  });
});

describe('the names as runtime reads them', () => {
  it('has none where nothing valid is saved', () => {
    expect(readInstitutionDisplayNames(undefined)).toEqual({});
    expect(readInstitutionDisplayNames('{}')).toEqual({});
    expect(readInstitutionDisplayNames('{"en":"only English"}')).toEqual({});
    expect(readInstitutionDisplayNames({ ja: 'x', en: 'y' })).toEqual({});
  });

  it('reads valid ones', () => {
    expect(readInstitutionDisplayNames('{"ja":"例大学","en":"Example University"}')).toEqual({
      ja: '例大学',
      en: 'Example University',
    });
  });
});

describe('a tenant’s institution from its effective settings', () => {
  it('is nothing for the defaults', () => {
    expect(
      institutionFromSettings({ 'institution.scopes': '', 'institution.display_names': '{}' })
    ).toEqual({ scopes: { state: 'unset' }, displayNames: {} });
    expect(institutionFromSettings({})).toEqual({ scopes: { state: 'unset' }, displayNames: {} });
  });

  it('keeps the scopes and the names apart: an invalid name does not touch the scopes', () => {
    expect(
      institutionFromSettings({
        'institution.scopes': 'example.ac.jp',
        'institution.display_names': 'broken',
      })
    ).toEqual({
      scopes: { state: 'set', scopes: ['example.ac.jp'], defaultScope: 'example.ac.jp' },
      displayNames: {},
    });
  });
});
