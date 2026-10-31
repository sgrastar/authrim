/**
 * `diagnostic-logging.filter_pii` protects personal data in full storage mode: only the exact
 * string `false` in the environment turns it off. Anything else, empty or unrecognised, leaves it
 * on, read through the real settings reader.
 */

import { describe, it, expect } from 'vitest';
import { resolveEffectiveSettings } from '../../../services/effective-settings';

const KEY = 'diagnostic-logging.filter_pii';

async function filterPii(env: Record<string, string | undefined>, stored?: unknown) {
  const documents: Record<string, string> =
    stored !== undefined
      ? { 'settings:tenant:t1:diagnostic-logging': JSON.stringify({ [KEY]: stored }) }
      : {};
  const kv = { get: async (key: string) => documents[key] ?? null } as unknown as KVNamespace;
  const values = await resolveEffectiveSettings(
    { SETTINGS: kv, ...env } as never,
    'diagnostic-logging',
    {
      tenantId: 't1',
    }
  );
  return values[KEY];
}

describe('DIAGNOSTIC_LOGGING_FILTER_PII', () => {
  it.each([
    'garbage',
    '0',
    'no',
    'off',
    'False',
    'FALSE',
    ' false',
    'false ',
    '',
    undefined,
    'true',
    '1',
  ])('keeps the filter on for %j', async (value) => {
    expect(await filterPii({ DIAGNOSTIC_LOGGING_FILTER_PII: value })).toBe(true);
  });

  it('turns it off only for the exact string false', async () => {
    expect(await filterPii({ DIAGNOSTIC_LOGGING_FILTER_PII: 'false' })).toBe(false);
  });

  it('lets a value saved for the tenant win over the environment', async () => {
    expect(await filterPii({ DIAGNOSTIC_LOGGING_FILTER_PII: 'false' }, true)).toBe(true);
    expect(await filterPii({ DIAGNOSTIC_LOGGING_FILTER_PII: 'garbage' }, false)).toBe(false);
  });
});
