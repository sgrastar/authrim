import { describe, expect, it } from 'vitest';
import { buildLoginUiClientRequestBody } from '../core/login-ui-client.js';
import {
  DEFAULT_LOGIN_UI_CLIENT_ID,
  buildLoginUiClientMetadata,
} from '../../../ar-management/src/login-ui-client-metadata';

// ar-management registers the same Login UI client for a tenant made through the Admin API.
// Setup's create and update requests both send buildLoginUiClientRequestBody; the two
// definitions must not drift.
describe('Login UI client definition', () => {
  it.each(['https://auth.example.com', 'https://tenant-a.example.com/'])(
    'is the same in setup and ar-management for %s',
    (origin) => {
      expect(buildLoginUiClientMetadata(origin.replace(/\/$/, ''))).toEqual(
        buildLoginUiClientRequestBody(origin)
      );
    }
  );

  it('falls back to the id the Login UI itself falls back to', () => {
    expect(DEFAULT_LOGIN_UI_CLIENT_ID).toBe('login-ui');
  });
});
