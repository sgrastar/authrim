import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import authApp from '../index';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const legacyDeviceBase = ['/api/auth', 'guest-device-login'].join('/');
const legacyDevicePaths = [`${legacyDeviceBase}/challenge`, `${legacyDeviceBase}/verify`];
const legacyAdminPath = ['/api/admin/settings', 'guest-auth'].join('/');
const browserGuestPath = ['/api/auth/guest', 'login'].join('/');
const readRepositoryFile = (path: string) => readFileSync(`${repositoryRoot}/${path}`, 'utf8');

describe('shared-HMAC device guest removal contract', () => {
  it('does not register the device challenge routes and retains browser guest login', () => {
    const registeredRoutes = authApp.routes.map(({ method, path }) => `${method} ${path}`);

    for (const path of legacyDevicePaths) expect(registeredRoutes).not.toContain(`POST ${path}`);
    expect(registeredRoutes).toContain(`POST ${browserGuestPath}`);
    expect(existsSync(`${repositoryRoot}/packages/ar-auth/src/guest-device-login.ts`)).toBe(false);
    expect(
      existsSync(`${repositoryRoot}/packages/ar-auth/src/__tests__/guest-device-login.test.ts`)
    ).toBe(false);
    expect(
      existsSync(
        `${repositoryRoot}/packages/ar-auth/src/__tests__/guest-device-login-handler.test.ts`
      )
    ).toBe(false);
  });

  it('does not publish the removed device login contract', () => {
    const openapi = readRepositoryFile('packages/ar-auth/openapi/auth.openapi.yaml');

    for (const path of legacyDevicePaths) expect(openapi).not.toContain(path);
    for (const component of [
      'GuestDeviceLoginChallenge:',
      'GuestDeviceLoginVerify:',
      'GuestDeviceLoginChallengeRequest:',
      'GuestDeviceLoginChallengeResponse:',
      'GuestDeviceLoginVerifyRequest:',
      'GuestDeviceLoginVerifyResponse:',
    ]) {
      expect(openapi).not.toContain(component);
    }
    expect(openapi).toContain(browserGuestPath);
  });

  it('does not leave removed fields attached to neighboring OpenAPI schemas', () => {
    const document = YAML.parse(
      readRepositoryFile('packages/ar-auth/openapi/auth.openapi.yaml')
    ) as {
      components?: {
        schemas?: Record<
          string,
          { type?: string; properties?: Record<string, unknown>; required?: string[] }
        >;
      };
    };
    const missingProperties: string[] = [];

    for (const [schemaName, schema] of Object.entries(document.components?.schemas ?? {})) {
      if (schema.type !== 'object') continue;
      for (const requiredName of schema.required ?? []) {
        if (!Object.hasOwn(schema.properties ?? {}, requiredName)) {
          missingProperties.push(`${schemaName}.${requiredName}`);
        }
      }
    }

    expect(missingProperties).toEqual([]);
  });

  it('does not retain shared device secrets, feature flags, or challenge signing code', () => {
    const coreSources = [
      'packages/ar-lib-core/src/types/env.ts',
      'packages/ar-lib-core/src/utils/feature-flags.ts',
      'packages/ar-lib-core/src/index.ts',
    ].map(readRepositoryFile);
    const source = coreSources.join('\n');
    const removedTokens = [
      ['DEVICE', 'HMAC', 'SECRET'].join('_'),
      ['ENABLE', 'GUEST', 'DEVICE', 'AUTH'].join('_'),
      ['create', 'ChallengeResponse'].join(''),
      ['verify', 'ChallengeResponse'].join(''),
      ['generate', 'DeviceChallenge'].join(''),
      ['hash', 'DeviceIdentifiers'].join(''),
      ['verify', 'DeviceSignature'].join(''),
    ];

    for (const token of removedTokens) expect(source).not.toContain(token);
    expect(
      existsSync(`${repositoryRoot}/packages/ar-lib-core/src/utils/device-fingerprint.ts`)
    ).toBe(false);
    expect(
      existsSync(
        `${repositoryRoot}/packages/ar-lib-core/src/utils/__tests__/device-fingerprint.test.ts`
      )
    ).toBe(false);
  });

  it('uses a browser resume credential contract internally instead of the removed device contract', () => {
    const sources = [
      'packages/ar-lib-core/src/services/account-provisioning.ts',
      'packages/ar-auth/src/account-provisioning.ts',
      'packages/ar-management/src/auth-account-provisioning-entrypoint.ts',
    ].map(readRepositoryFile);
    const source = sources.join('\n');

    for (const token of [
      'AuthGuestDevice',
      'guestDevice',
      'guestDeviceLookupSubject',
      'removeAuthGuestDeviceRoute',
      'installationIdHash',
      'fingerprintHash',
      "'installation', 'device'",
      'urn:authrim:guest-device:v1',
    ]) {
      expect(source).not.toContain(token);
    }
    expect(source).toContain('guestResumeCredential');
    expect(source).toContain('credentialHash');
    expect(source).toContain('urn:authrim:guest-resume:v1');
  });

  it('keeps removed admin settings out of the current route and OpenAPI inventories', () => {
    const managementRoutes = readRepositoryFile('packages/ar-management/src/index.ts');
    const managementOpenapi = readRepositoryFile(
      'packages/ar-management/openapi/admin.openapi.yaml'
    );

    expect(managementRoutes).not.toContain(legacyAdminPath);
    expect(managementOpenapi).not.toContain(legacyAdminPath);
    for (const path of legacyDevicePaths) expect(managementOpenapi).not.toContain(path);
  });

  it('does not retain legacy shared-HMAC credential rows as browser resume credentials', () => {
    const d1Migration = readRepositoryFile('migrations/core/d1/003_account_registration_state.sql');
    const postgresMigration = readRepositoryFile(
      'migrations/core/postgresql/003_account_registration_state.sql'
    );

    expect(d1Migration).not.toMatch(/INSERT INTO guest_devices[\s\S]+FROM guest_devices_legacy/u);
    expect(postgresMigration).toContain('TRUNCATE TABLE guest_devices');
  });
});
