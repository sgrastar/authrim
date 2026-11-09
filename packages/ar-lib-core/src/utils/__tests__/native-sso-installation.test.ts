import { describe, expect, it } from 'vitest';
import type { ClientMetadata, DeviceInstallation, DeviceSecret } from '../../types/oidc';
import {
  buildNativeSSOInstallationMetadata,
  buildNativeSSOInstallationMetadataFromInstallation,
  formatNativeSSOInstallationTime,
  getDeviceSecretClientId,
  getDeviceSecretInstallationId,
  normalizeNativeSSOInstallationPlatform,
} from '../native-sso-installation';

const deviceSecret = {
  id: 'secret-1',
  installation_id: 'installation-1',
  tenant_id: 'tenant-a',
  client_id: 'client-a',
  user_id: 'user-a',
  session_id: 'session-a',
  secret_hash: 'hash',
  device_name: 'My phone',
  device_platform: 'ios',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  expires_at: 1_800_000_000_000,
  last_used_at: 1_700_000_000_999,
  use_count: 1,
  is_active: 1,
} satisfies DeviceSecret;

const installation = {
  id: 'installation-2',
  tenant_id: 'tenant-a',
  user_id: 'user-a',
  client_id: 'client-b',
  display_name: 'Work laptop',
  device_platform: 'windows',
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
  last_seen_at: 1_700_000_001_999,
  is_active: 1,
} satisfies DeviceInstallation;

describe('Native SSO installation metadata', () => {
  it('keeps the canonical installation and client identity on a device secret', () => {
    expect(getDeviceSecretInstallationId(deviceSecret)).toBe('installation-1');
    expect(getDeviceSecretClientId(deviceSecret, 'fallback-client')).toBe('client-a');
    expect(
      buildNativeSSOInstallationMetadata({
        deviceSecret,
        fallbackClientId: 'fallback-client',
        clientMetadata: { client_name: 'Example App' } as ClientMetadata,
        fallbackLastSeenAtMs: 1_600_000_000_000,
      })
    ).toEqual({
      installation_id: 'installation-1',
      client_id: 'client-a',
      platform: 'ios',
      display_name: 'My phone',
      last_seen_at: '2023-11-14T22:13:20Z',
      last_seen_at_unix: 1_700_000_000,
      app_display_name: 'Example App',
    });
  });

  it('uses legacy identity and presentation fallbacks without inventing an app name', () => {
    const metadata = buildNativeSSOInstallationMetadata({
      deviceSecret: {
        ...deviceSecret,
        installation_id: undefined,
        client_id: undefined,
        device_name: undefined,
        device_platform: undefined,
        last_used_at: undefined,
      },
      fallbackClientId: 'original-client',
      clientMetadata: { client_name: '' } as ClientMetadata,
      fallbackLastSeenAtMs: 1_700_000_002_999,
    });

    expect(metadata).toEqual({
      installation_id: 'secret-1',
      client_id: 'original-client',
      platform: 'unknown',
      display_name: '',
      fallback_display_name: 'Native device',
      last_seen_at: '2023-11-14T22:13:22Z',
      last_seen_at_unix: 1_700_000_002,
    });
  });

  it('uses canonical installation fields even when no device secret is linked', () => {
    expect(
      buildNativeSSOInstallationMetadataFromInstallation({
        installation,
        fallbackClientId: 'fallback-client',
        clientMetadata: { client_name: 'Work App' } as ClientMetadata,
        fallbackLastSeenAtMs: 1_600_000_000_000,
      })
    ).toEqual({
      installation_id: 'installation-2',
      client_id: 'client-b',
      platform: 'windows',
      display_name: 'Work laptop',
      last_seen_at: '2023-11-14T22:13:21Z',
      last_seen_at_unix: 1_700_000_001,
      app_display_name: 'Work App',
    });
  });

  it('uses a platform-specific fallback for an unnamed installation', () => {
    const metadata = buildNativeSSOInstallationMetadataFromInstallation({
      installation: {
        ...installation,
        client_id: undefined,
        display_name: undefined,
        last_seen_at: undefined,
      },
      fallbackClientId: 'fallback-client',
      fallbackLastSeenAtMs: 1_700_000_003_999,
    });

    expect(metadata).toMatchObject({
      client_id: 'fallback-client',
      display_name: '',
      fallback_display_name: 'windows device',
      last_seen_at: '2023-11-14T22:13:23Z',
      last_seen_at_unix: 1_700_000_003,
    });
    expect(metadata).not.toHaveProperty('app_display_name');
  });

  it('honors a recorded zero timestamp rather than replacing it with the fallback', () => {
    const metadata = buildNativeSSOInstallationMetadata({
      deviceSecret: { ...deviceSecret, last_used_at: 0 },
      fallbackClientId: 'fallback-client',
      fallbackLastSeenAtMs: 1_700_000_000_000,
    });
    expect(metadata.last_seen_at).toBe('1970-01-01T00:00:00Z');
    expect(metadata.last_seen_at_unix).toBe(0);
    expect(formatNativeSSOInstallationTime(-1)).toEqual({
      rfc3339: '1969-12-31T23:59:59Z',
      unix: -1,
    });
  });

  it('accepts only documented platforms from untrusted stored values', () => {
    for (const platform of ['ios', 'android', 'macos', 'windows', 'other'] as const) {
      expect(normalizeNativeSSOInstallationPlatform(platform)).toBe(platform);
    }
    for (const platform of ['linux', '', 12, null, undefined]) {
      expect(normalizeNativeSSOInstallationPlatform(platform)).toBe('unknown');
    }
  });
});
