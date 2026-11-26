import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  accountPagePathFromDocument,
  loginUiSettingsFromDocument,
  parseAuthenticationMethodsDocument,
  passkeyEndpointsHandler,
  passkeyLoginEnabledFromDocument,
} from '../passkey-endpoints';

const LOGIN = 'authentication-methods.passkey.login_enabled';
const LEGACY = 'authentication-methods.passkey.enabled';

function doc(values: Record<string, unknown>): string {
  return JSON.stringify(values);
}

describe('passkeyLoginEnabledFromDocument: boolean spellings', () => {
  it.each([
    ['the string true', { [LOGIN]: 'true', [LEGACY]: false }, true],
    ['an upper-case padded TRUE', { [LOGIN]: ' TRUE ', [LEGACY]: false }, true],
    ['the string false', { [LOGIN]: 'false' }, false],
    ['a mixed-case padded False', { [LOGIN]: ' False ' }, false],
    ['a boolean true', { [LOGIN]: true, [LEGACY]: false }, true],
    ['a boolean false', { [LOGIN]: false }, false],
  ])('reads %s', (_label, values, expected) => {
    expect(passkeyLoginEnabledFromDocument(doc(values))).toBe(expected);
  });

  it.each([
    ['an unrecognised string', { [LOGIN]: 'maybe', [LEGACY]: false }, false],
    ['an unrecognised string over an enabled legacy switch', { [LOGIN]: 'maybe' }, true],
    ['a number', { [LOGIN]: 1, [LEGACY]: false }, false],
    ['the legacy switch alone', { [LEGACY]: false }, false],
    ['the legacy switch as a string', { [LEGACY]: 'true' }, true],
    ['nothing set', {}, true],
  ])('falls back for %s', (_label, values, expected) => {
    expect(passkeyLoginEnabledFromDocument(doc(values))).toBe(expected);
  });

  it('treats a missing document as nothing set', () => {
    expect(passkeyLoginEnabledFromDocument(null)).toBe(true);
    expect(passkeyLoginEnabledFromDocument(undefined)).toBe(true);
  });
});

describe('parseAuthenticationMethodsDocument', () => {
  it('returns an empty object for a missing document and the object for a valid one', () => {
    expect(parseAuthenticationMethodsDocument(null)).toEqual({});
    expect(parseAuthenticationMethodsDocument(undefined)).toEqual({});
    expect(parseAuthenticationMethodsDocument('{"a":1}')).toEqual({ a: 1 });
  });

  it.each([['null'], ['[]'], ['[1]'], ['5'], ['"text"'], ['true'], ['0']])(
    'rejects %s with the dedicated error',
    (raw) => {
      expect(() => parseAuthenticationMethodsDocument(raw)).toThrow(
        'authentication_methods_settings_invalid'
      );
    }
  );

  it('lets invalid JSON surface as a syntax error', () => {
    expect(() => parseAuthenticationMethodsDocument('{')).toThrow(SyntaxError);
  });
});

describe('accountPagePathFromDocument: documents that are not objects', () => {
  it.each([['null'], ['[]'], ['5'], ['"text"'], ['{'], ['']])('counts %j as nothing set', (raw) => {
    expect(accountPagePathFromDocument(raw)).toBe('/account');
  });

  it('counts a missing document as nothing set', () => {
    expect(accountPagePathFromDocument(null)).toBe('/account');
    expect(accountPagePathFromDocument(undefined)).toBe('/account');
  });
});

describe('loginUiSettingsFromDocument', () => {
  it('returns the object of a valid document', () => {
    expect(loginUiSettingsFromDocument('{"a":1}')).toEqual({ a: 1 });
    expect(loginUiSettingsFromDocument('{}')).toEqual({});
  });

  it.each([[null], [undefined], [''], ['null'], ['[]'], ['[{"a":1}]'], ['5'], ['"s"'], ['{']])(
    'returns null for %j',
    (raw) => {
      expect(loginUiSettingsFromDocument(raw)).toBeNull();
    }
  );
});

describe('passkeyEndpointsHandler: unpublished responses', () => {
  function kv(entries: Record<string, string>, fail = false): KVNamespace {
    return {
      get: async (key: string) => {
        if (fail) throw new Error('kv unavailable');
        return entries[key] ?? null;
      },
    } as unknown as KVNamespace;
  }

  async function request(entries: Record<string, string>, fail = false): Promise<Response> {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'default');
      await next();
    });
    app.get('/.well-known/passkey-endpoints', passkeyEndpointsHandler);
    return app.fetch(new Request('https://auth.example.com/.well-known/passkey-endpoints'), {
      ISSUER_URL: 'https://auth.example.com',
      SETTINGS: kv(entries, fail),
      AUTHRIM_CONFIG: kv({}),
    });
  }

  const NOT_FOUND = { error: 'not_found', message: 'The requested resource was not found' };

  it('answers an unreadable settings store with an uncacheable 404', async () => {
    const response = await request({}, true);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Vary')).toBe('Host');
    expect(await response.json()).toEqual(NOT_FOUND);
  });

  it('answers a damaged authentication-methods document with an uncacheable 404', async () => {
    const response = await request({ 'settings:tenant:default:authentication-methods': '[]' });
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('answers an unpublished endpoint with the cacheable 404 and its Vary header', async () => {
    const response = await request({
      'settings:tenant:default:authentication-methods': doc({ [LOGIN]: false }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(response.headers.get('Vary')).toBe('Host');
    expect(await response.json()).toEqual(NOT_FOUND);
  });

  it('applies the platform default of the authentication methods under the tenant document', async () => {
    const response = await request({
      'settings:platform:authentication-methods': doc({ [LOGIN]: false }),
    });
    expect(response.status).toBe(404);
  });
});
