import type { Context } from 'hono';
import {
  buildNativeSSOInstallationMetadata as buildDeviceSecretInstallationMetadata,
  buildNativeSSOInstallationMetadataFromInstallation,
  calculateDsHash,
  createPhase1ErrorDetails,
  timingSafeEqual,
  type ClientMetadata,
  type DeviceInstallation,
  type DeviceSecret,
  type Env,
  type Logger,
  type NativeSSOErrorDetailCode,
  type Phase1ErrorDetailSeverity,
  type Phase1ErrorDetailUserAction,
  type TokenTypeURN,
} from '@authrim/ar-lib-core';

export const NATIVE_SSO_ID_TOKEN_CLOCK_SKEW_SECONDS = 60;

export type RefreshTokenExpiryMetadata = {
  refresh_token_expires_in: number;
  refresh_token_expires_at: string;
  refresh_token_expires_at_unix: number;
};

export type NativeSSOPlatform = 'ios' | 'android' | 'macos' | 'windows' | 'other' | 'unknown';
export type StoredNativeSSOPlatform = Exclude<NativeSSOPlatform, 'unknown'>;

export type NativeSSOInstallationMetadata = {
  installation_id: string;
  client_id: string;
  platform: NativeSSOPlatform;
  display_name: string;
  fallback_display_name?: string;
  last_seen_at: string;
  last_seen_at_unix: number;
  app_display_name?: string;
};

type NativeSSOTokenExchangeSuccessResponse = NativeSSOInstallationMetadata & {
  access_token: string;
  issued_token_type: TokenTypeURN;
  token_type: 'DPoP';
  expires_in: number;
  id_token: string;
  refresh_token?: string;
  scope: string;
} & Partial<RefreshTokenExpiryMetadata>;

export type NativeSSOFailureAuditContext = {
  logger: Logger;
  clientId?: string;
  subjectTokenType?: string;
  actorTokenType?: string;
  requestedAudiences?: string[];
  requestedResources?: string[];
};

type NativeSSOFailureOutcome = 'denied' | 'invalid_grant' | 'invalid_request';

function getNativeSSOFailureOutcome(error: string): NativeSSOFailureOutcome {
  if (error === 'invalid_grant') {
    return 'invalid_grant';
  }
  if (error === 'invalid_request') {
    return 'invalid_request';
  }
  return 'denied';
}

function auditNativeSSOTokenExchangeFailure(
  audit: NativeSSOFailureAuditContext,
  input: {
    error: string;
    code: NativeSSOErrorDetailCode;
    status: number;
  }
): void {
  audit.logger.warn('NativeSSO Token Exchange Failure', {
    action: 'NativeSSO',
    outcome: getNativeSSOFailureOutcome(input.error),
    clientId: audit.clientId,
    subjectTokenType: audit.subjectTokenType,
    actorTokenType: audit.actorTokenType,
    error: input.error,
    errorDetailsCode: input.code,
    status: input.status,
    requestedAudiences: audit.requestedAudiences ?? [],
    requestedResources: audit.requestedResources ?? [],
  });
}

export function nativeSSOError(
  c: Context<{ Bindings: Env }>,
  error: string,
  errorDescription: string,
  code: NativeSSOErrorDetailCode,
  status: 400 | 401 | 403 | 429 | 500 | 503 = 400,
  userAction: Phase1ErrorDetailUserAction = 'reauthenticate',
  options: {
    retryable?: boolean;
    severity?: Phase1ErrorDetailSeverity;
    retryAfterSeconds?: number;
    audit?: NativeSSOFailureAuditContext;
  } = {}
): Response {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  if (options.retryAfterSeconds !== undefined) {
    c.header('Retry-After', String(options.retryAfterSeconds));
  }
  if (options.audit) {
    auditNativeSSOTokenExchangeFailure(options.audit, { error, code, status });
  }

  return c.json(
    {
      error,
      error_description: errorDescription,
      error_details: createPhase1ErrorDetails(code, {
        ...(options.retryable !== undefined && { retryable: options.retryable }),
        ...(options.severity && { severity: options.severity }),
        user_action: userAction,
      }),
    },
    status
  );
}

export function nativeSSOInvalidGrant(
  c: Context<{ Bindings: Env }>,
  errorDescription: string,
  code: NativeSSOErrorDetailCode,
  options: {
    audit?: NativeSSOFailureAuditContext;
  } = {}
): Response {
  return nativeSSOError(c, 'invalid_grant', errorDescription, code, 400, 'reauthenticate', options);
}

export async function validateNativeSSODeviceSecretBinding(
  idTokenPayload: Record<string, unknown>,
  deviceSecret: string
): Promise<boolean> {
  const idTokenDsHash = idTokenPayload.ds_hash;
  if (typeof idTokenDsHash !== 'string' || idTokenDsHash.length === 0) {
    return false;
  }

  const presentedDsHash = await calculateDsHash(deviceSecret);
  return timingSafeEqual(presentedDsHash, idTokenDsHash);
}

export function normalizeNativeSSOAudience(audience: unknown): string[] | null {
  if (typeof audience === 'string' && audience.length > 0) {
    return [audience];
  }

  if (
    Array.isArray(audience) &&
    audience.length > 0 &&
    audience.every((item): item is string => typeof item === 'string' && item.length > 0)
  ) {
    return audience;
  }

  return null;
}

export function isNativeSSOClientEnabled(clientMetadata: ClientMetadata): boolean {
  if (clientMetadata.native_sso_enabled === false) {
    return false;
  }

  if (clientMetadata.native_sso_enabled === true) {
    return true;
  }

  return clientMetadata.application_type === 'native';
}

export function isNativeSSONativeChannelAllowed(clientMetadata: ClientMetadata): boolean {
  const metadata = clientMetadata as ClientMetadata & {
    native_channel_allowed?: unknown;
    allowed_channels?: unknown;
  };

  if (metadata.native_channel_allowed === false) {
    return false;
  }

  if (Array.isArray(metadata.allowed_channels)) {
    return metadata.allowed_channels.includes('native');
  }

  return clientMetadata.application_type === 'native';
}

export function isNativeSSOIssuanceEligible(
  clientMetadata: ClientMetadata,
  requestChannel: string | undefined
): boolean {
  if (clientMetadata.native_sso_enabled === false) {
    return false;
  }

  if (clientMetadata.application_type !== 'native') {
    return false;
  }

  if (!isNativeSSONativeChannelAllowed(clientMetadata)) {
    return false;
  }

  return requestChannel === undefined || requestChannel === 'native';
}

export function normalizeNativeSSOPlatform(platform: unknown): NativeSSOPlatform {
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

export function normalizeDeviceSecretPlatform(
  platform: unknown
): StoredNativeSSOPlatform | undefined {
  const normalized = normalizeNativeSSOPlatform(platform);
  return normalized === 'unknown' ? undefined : normalized;
}

export function normalizeDeviceSecretName(deviceName: unknown): string | undefined {
  if (typeof deviceName !== 'string') {
    return undefined;
  }

  const normalized = deviceName.trim().replace(/\s+/g, ' ');
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 64);
}

export function buildNativeSSOInstallationMetadata(
  deviceSecret: DeviceSecret,
  clientId: string,
  clientMetadata: ClientMetadata,
  fallbackLastSeenAtMs: number
): NativeSSOInstallationMetadata {
  return buildDeviceSecretInstallationMetadata({
    deviceSecret,
    fallbackClientId: clientId,
    clientMetadata,
    fallbackLastSeenAtMs,
  });
}

export function buildNativeSSOInstallationMetadataForIssuedInstallation(
  installation: DeviceInstallation | null,
  fallbackDeviceSecret: DeviceSecret,
  clientId: string,
  clientMetadata: ClientMetadata,
  fallbackLastSeenAtMs: number
): NativeSSOInstallationMetadata {
  if (installation) {
    return buildNativeSSOInstallationMetadataFromInstallation({
      installation,
      fallbackClientId: clientId,
      clientMetadata,
      fallbackLastSeenAtMs,
    });
  }

  return buildNativeSSOInstallationMetadata(
    fallbackDeviceSecret,
    clientId,
    clientMetadata,
    fallbackLastSeenAtMs
  );
}

export function buildNativeSSOTokenExchangeSuccessResponse(input: {
  accessToken: string;
  expiresIn: number;
  idToken: string;
  installationMetadata: NativeSSOInstallationMetadata;
  refreshToken?: string;
  refreshTokenExpiryMetadata?: RefreshTokenExpiryMetadata;
  scope: string;
}): NativeSSOTokenExchangeSuccessResponse {
  return {
    access_token: input.accessToken,
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' as TokenTypeURN,
    token_type: 'DPoP',
    expires_in: input.expiresIn,
    id_token: input.idToken,
    ...input.installationMetadata,
    ...(input.refreshToken && { refresh_token: input.refreshToken }),
    ...input.refreshTokenExpiryMetadata,
    scope: input.scope,
  };
}
