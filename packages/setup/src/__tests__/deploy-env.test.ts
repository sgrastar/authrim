import { describe, expect, it } from 'vitest';
import { buildUiWorkerBuildEnv } from '../core/deploy.js';

describe('buildUiWorkerBuildEnv', () => {
  it('strips leaked UI env vars when package-local .env should win', () => {
    const buildEnv = buildUiWorkerBuildEnv(
      {
        PATH: '/usr/bin',
        PUBLIC_API_BASE_URL: 'https://leaked.example.com',
        PUBLIC_API_PROXY_BACKEND_URL: 'https://leaked.example.com',
        PUBLIC_AUTHRIM_ISSUER: 'https://leaked.example.com',
        PUBLIC_LOGIN_UI_CLIENT_ID: 'leaked-client',
        API_BACKEND_URL: 'https://leaked.example.com',
      },
      {
        apiBaseUrl: 'https://api.example.com',
        preferPackageEnv: true,
      }
    );

    expect(buildEnv.PATH).toBe('/usr/bin');
    expect(buildEnv.PUBLIC_API_BASE_URL).toBeUndefined();
    expect(buildEnv.PUBLIC_API_PROXY_BACKEND_URL).toBeUndefined();
    expect(buildEnv.PUBLIC_AUTHRIM_ISSUER).toBeUndefined();
    expect(buildEnv.PUBLIC_LOGIN_UI_CLIENT_ID).toBeUndefined();
    expect(buildEnv.API_BACKEND_URL).toBeUndefined();
  });

  it('injects the requested API URL only for legacy fallback builds', () => {
    const buildEnv = buildUiWorkerBuildEnv(
      {
        PATH: '/usr/bin',
        PUBLIC_API_BASE_URL: 'https://stale.example.com',
        PUBLIC_API_PROXY_BACKEND_URL: 'https://stale.example.com',
        PUBLIC_AUTHRIM_ISSUER: 'https://stale.example.com',
      },
      {
        apiBaseUrl: 'https://api.example.com',
        preferPackageEnv: false,
      }
    );

    expect(buildEnv.PATH).toBe('/usr/bin');
    expect(buildEnv.PUBLIC_API_BASE_URL).toBe('https://api.example.com');
    expect(buildEnv.PUBLIC_API_PROXY_BACKEND_URL).toBeUndefined();
    expect(buildEnv.PUBLIC_AUTHRIM_ISSUER).toBeUndefined();
    expect(buildEnv.API_BACKEND_URL).toBeUndefined();
  });
});
