import { describe, expect, it, vi } from 'vitest';
import {
  ASSURANCE_LEVELS_DEFAULTS,
  ASSURANCE_LEVELS_SETTINGS_META,
  DEFAULT_SCIM_MAX_IAL,
  SCIM_MAX_IAL_MAX,
  SCIM_MAX_IAL_MIN,
} from '../../types/settings/assurance-levels';
import { IAL_LEVELS } from '../identity-assurance';
import {
  resolveScimMaxIAL,
  ScimMaxIALUnavailableError,
  scimClaimWithinMaxIAL,
} from '../organisation-assurance';

const kv = (values: Record<string, string>, fail = false): KVNamespace =>
  ({
    get: vi.fn(async (key: string) => {
      if (fail) throw new Error('kv down');
      return values[key] ?? null;
    }),
  }) as unknown as KVNamespace;
const saved = (value: unknown) => ({
  'settings:tenant:t:assurance': JSON.stringify({ 'assurance.scim_max_ial': value }),
});

describe('assurance.scim_max_ial', () => {
  it('is an integer over the IALs of the service, IAL1 by default', () => {
    const meta = ASSURANCE_LEVELS_SETTINGS_META['assurance.scim_max_ial'];
    expect(DEFAULT_SCIM_MAX_IAL).toBe(1);
    expect(meta).toMatchObject({
      type: 'number',
      default: DEFAULT_SCIM_MAX_IAL,
      envKey: 'SCIM_MAX_IAL',
      min: SCIM_MAX_IAL_MIN,
      max: SCIM_MAX_IAL_MAX,
      integer: true,
      envNumber: 'strict-in-range',
    });
    expect(meta.status).toBeUndefined();
    expect(ASSURANCE_LEVELS_DEFAULTS['assurance.scim_max_ial']).toBe(DEFAULT_SCIM_MAX_IAL);
    expect([SCIM_MAX_IAL_MIN, SCIM_MAX_IAL_MAX]).toEqual([1, IAL_LEVELS.length]);
  });

  it('is IAL1 until the tenant raises it', async () => {
    expect(await resolveScimMaxIAL({ SETTINGS: kv({}) }, 't')).toBe('IAL1');
    expect(await resolveScimMaxIAL({ SETTINGS: kv(saved(2)) }, 't')).toBe('IAL2');
    expect(await resolveScimMaxIAL({ SETTINGS: kv(saved(3)) }, 't')).toBe('IAL3');
    // Another tenant's setting is not this tenant's.
    expect(await resolveScimMaxIAL({ SETTINGS: kv(saved(3)) }, 'other')).toBe('IAL1');
  });

  it('takes the SCIM_MAX_IAL environment value only when the whole value is a level; an invalid one is ignored and the default (IAL1) applies', async () => {
    const fromEnv = (value: string) =>
      resolveScimMaxIAL({ SETTINGS: kv({}), SCIM_MAX_IAL: value } as never, 't');
    expect(await fromEnv('2')).toBe('IAL2');
    expect(await fromEnv(' 3 ')).toBe('IAL3');
    // An invalid environment value is ignored and the default (IAL1) applies: it can never
    // raise the ceiling (only lower it to the most restrictive value). Not a 503: that is for
    // an unreadable tenant setting or an invalid tenant value (below).
    for (const bad of ['0', '4', '-1', '2junk', '1.5', '2.9', 'two', '']) {
      expect(await fromEnv(bad), bad).toBe('IAL1');
    }
  });

  it('fails closed (503) when the tenant setting cannot be read or holds something that is not a level', async () => {
    await expect(resolveScimMaxIAL({ SETTINGS: kv({}, true) }, 't')).rejects.toBeInstanceOf(
      ScimMaxIALUnavailableError
    );
    for (const bad of [0, 4, 1.5, '2', null, 'IAL2']) {
      await expect(
        resolveScimMaxIAL({ SETTINGS: kv(saved(bad)) }, 't'),
        String(bad)
      ).rejects.toBeInstanceOf(ScimMaxIALUnavailableError);
    }
  });

  it('allows a claim up to the ceiling', () => {
    expect(scimClaimWithinMaxIAL('IAL1', 'IAL1')).toBe(true);
    expect(scimClaimWithinMaxIAL('IAL2', 'IAL1')).toBe(false);
    expect(scimClaimWithinMaxIAL('IAL3', 'IAL2')).toBe(false);
    expect(scimClaimWithinMaxIAL('IAL2', 'IAL3')).toBe(true);
    expect(scimClaimWithinMaxIAL('IAL1', 'IAL3')).toBe(true);
  });
});
