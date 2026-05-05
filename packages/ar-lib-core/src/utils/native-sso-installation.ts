import type { ClientMetadata, DeviceInstallation, DeviceSecret } from '../types/oidc';

export type NativeSSOInstallationMetadata = {
  installation_id: string;
  client_id: string;
  platform: 'ios' | 'android' | 'macos' | 'windows' | 'other' | 'unknown';
  display_name: string;
  fallback_display_name?: string;
  last_seen_at: string;
  last_seen_at_unix: number;
  app_display_name?: string;
};

export function getDeviceSecretInstallationId(deviceSecret: Pick<DeviceSecret, 'id' | 'installation_id'>): string {
  return deviceSecret.installation_id ?? deviceSecret.id;
}

export function getDeviceSecretClientId(
  deviceSecret: Pick<DeviceSecret, 'client_id'>,
  fallbackClientId: string
): string {
  return deviceSecret.client_id ?? fallbackClientId;
}

export function normalizeNativeSSOInstallationPlatform(
  platform: unknown
): NativeSSOInstallationMetadata['platform'] {
  if (
    platform === 'ios' ||
    platform === 'android' ||
    platform === 'macos' ||
    platform === 'windows' ||
    platform === 'other'
  ) {
    return platform;
  }

  return 'unknown';
}

export function formatNativeSSOInstallationTime(epochMilliseconds: number): {
  rfc3339: string;
  unix: number;
} {
  const unix = Math.floor(epochMilliseconds / 1000);
  return {
    rfc3339: new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    unix,
  };
}

export function buildNativeSSOInstallationMetadata(input: {
  deviceSecret: DeviceSecret;
  fallbackClientId: string;
  clientMetadata?: ClientMetadata | null;
  fallbackLastSeenAtMs: number;
}): NativeSSOInstallationMetadata {
  const platform = normalizeNativeSSOInstallationPlatform(input.deviceSecret.device_platform);
  const displayName = input.deviceSecret.device_name ?? '';
  const lastSeen = formatNativeSSOInstallationTime(
    input.deviceSecret.last_used_at ?? input.fallbackLastSeenAtMs
  );
  const appDisplayName =
    typeof input.clientMetadata?.client_name === 'string' && input.clientMetadata.client_name.length > 0
      ? input.clientMetadata.client_name
      : undefined;

  return {
    installation_id: getDeviceSecretInstallationId(input.deviceSecret),
    client_id: getDeviceSecretClientId(input.deviceSecret, input.fallbackClientId),
    platform,
    display_name: displayName,
    ...(displayName.length === 0 && {
      fallback_display_name: platform === 'unknown' ? 'Native device' : `${platform} device`,
    }),
    last_seen_at: lastSeen.rfc3339,
    last_seen_at_unix: lastSeen.unix,
    ...(appDisplayName && { app_display_name: appDisplayName }),
  };
}

export function buildNativeSSOInstallationMetadataFromInstallation(input: {
  installation: DeviceInstallation;
  fallbackClientId: string;
  clientMetadata?: ClientMetadata | null;
  fallbackLastSeenAtMs: number;
}): NativeSSOInstallationMetadata {
  const platform = normalizeNativeSSOInstallationPlatform(input.installation.device_platform);
  const displayName = input.installation.display_name ?? '';
  const lastSeen = formatNativeSSOInstallationTime(
    input.installation.last_seen_at ?? input.fallbackLastSeenAtMs
  );
  const appDisplayName =
    typeof input.clientMetadata?.client_name === 'string' && input.clientMetadata.client_name.length > 0
      ? input.clientMetadata.client_name
      : undefined;

  return {
    installation_id: input.installation.id,
    client_id: input.installation.client_id ?? input.fallbackClientId,
    platform,
    display_name: displayName,
    ...(displayName.length === 0 && {
      fallback_display_name: platform === 'unknown' ? 'Native device' : `${platform} device`,
    }),
    last_seen_at: lastSeen.rfc3339,
    last_seen_at_unix: lastSeen.unix,
    ...(appDisplayName && { app_display_name: appDisplayName }),
  };
}
