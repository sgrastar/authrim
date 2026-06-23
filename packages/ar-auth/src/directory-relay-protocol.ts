export const DIRECTORY_RELAY_PROTOCOL = 'authrim.wordwarden.relay.v1';
export const DIRECTORY_RELAY_PROTOCOL_VERSION = 1;
export const DIRECTORY_RELAY_MIN_SUPPORTED_VERSION = 1;
export const DIRECTORY_RELAY_HMAC_ALGORITHM = 'AUTHRIM-WORDWARDEN-RELAY-HMAC-SHA256';

export interface DirectoryRelayChallengeMessage {
  type: 'auth.challenge';
  protocol: typeof DIRECTORY_RELAY_PROTOCOL;
  protocol_version: typeof DIRECTORY_RELAY_PROTOCOL_VERSION;
  min_supported_version: typeof DIRECTORY_RELAY_MIN_SUPPORTED_VERSION;
  challenge_id: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
}

export interface DirectoryRelayAuthResponseMessage {
  type: 'auth.response';
  protocol: typeof DIRECTORY_RELAY_PROTOCOL;
  protocol_version: number;
  min_supported_version: number;
  tenant_id: string;
  connector_id: string;
  key_id: string;
  challenge_id: string;
  nonce: string;
  timestamp: string;
  signature: string;
}

export interface DirectoryRelayAuthOkMessage {
  type: 'auth.ok';
  protocol: typeof DIRECTORY_RELAY_PROTOCOL;
  protocol_version: typeof DIRECTORY_RELAY_PROTOCOL_VERSION;
  min_supported_version: typeof DIRECTORY_RELAY_MIN_SUPPORTED_VERSION;
  tenant_id: string;
  connector_id: string;
}

export interface DirectoryRelayVerifyRequestMessage {
  type: 'verify.request';
  protocol: typeof DIRECTORY_RELAY_PROTOCOL;
  protocol_version: typeof DIRECTORY_RELAY_PROTOCOL_VERSION;
  min_supported_version: typeof DIRECTORY_RELAY_MIN_SUPPORTED_VERSION;
  id: string;
  request_id: string;
  tenant_id: string;
  connector_id: string;
  username: string;
  password: string;
  attribute_names: string[];
}

export interface DirectoryRelayVerifyResponseMessage {
  type: 'verify.response';
  protocol: typeof DIRECTORY_RELAY_PROTOCOL;
  protocol_version: number;
  min_supported_version: number;
  id: string;
  request_id: string;
  tenant_id: string;
  connector_id: string;
  result: 'success' | 'failure' | 'policy_required';
  subject?: {
    directory_id: string;
    username: string;
  };
  attributes?: Record<string, string[]>;
  reason?: string;
  directory_status: 'ok';
}

export interface DirectoryRelayVerifyErrorMessage {
  type: 'verify.error';
  protocol: typeof DIRECTORY_RELAY_PROTOCOL;
  protocol_version: number;
  min_supported_version: number;
  id: string;
  request_id?: string;
  tenant_id?: string;
  connector_id?: string;
  error: {
    code: string;
    retryable: boolean;
  };
}

export interface DirectoryRelayErrorMessage {
  type: 'error';
  protocol: typeof DIRECTORY_RELAY_PROTOCOL;
  protocol_version: typeof DIRECTORY_RELAY_PROTOCOL_VERSION;
  min_supported_version: typeof DIRECTORY_RELAY_MIN_SUPPORTED_VERSION;
  code: string;
  message: string;
}

export type DirectoryRelayClientMessage =
  | DirectoryRelayAuthResponseMessage
  | DirectoryRelayVerifyResponseMessage
  | DirectoryRelayVerifyErrorMessage;

export function buildDirectoryRelayAuthCanonical(input: {
  tenantId: string;
  connectorId: string;
  keyId: string;
  protocolVersion: number;
  minSupportedVersion: number;
  challengeId: string;
  nonce: string;
  timestamp: string;
}): string {
  return [
    DIRECTORY_RELAY_HMAC_ALGORITHM,
    input.tenantId,
    input.connectorId,
    input.keyId,
    String(input.protocolVersion),
    String(input.minSupportedVersion),
    input.challengeId,
    input.nonce,
    input.timestamp,
  ].join('\n');
}

export async function signDirectoryRelayCanonical(
  canonical: string,
  secret: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
  return bytesToHex(new Uint8Array(signature));
}

export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) {
    return false;
  }
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  const maxLength = Math.max(normalizedLeft.length, normalizedRight.length);
  let diff = normalizedLeft.length ^ normalizedRight.length;
  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = normalizedLeft.charCodeAt(index) || 0;
    const rightCode = normalizedRight.charCodeAt(index) || 0;
    diff |= leftCode ^ rightCode;
  }
  return diff === 0;
}

export function isDirectoryRelayClientMessage(
  value: unknown
): value is DirectoryRelayClientMessage {
  if (!isRecord(value) || value.protocol !== DIRECTORY_RELAY_PROTOCOL) return false;
  if (!relayProtocolVersionsCompatible(value)) return false;
  return (
    value.type === 'auth.response' ||
    value.type === 'verify.response' ||
    value.type === 'verify.error'
  );
}

export function relayProtocolVersionsCompatible(value: Record<string, unknown>): boolean {
  const protocolVersion = value.protocol_version;
  const minSupportedVersion = value.min_supported_version;
  if (!Number.isInteger(protocolVersion) || !Number.isInteger(minSupportedVersion)) return false;
  return (
    (minSupportedVersion as number) <= DIRECTORY_RELAY_PROTOCOL_VERSION &&
    (protocolVersion as number) >= DIRECTORY_RELAY_MIN_SUPPORTED_VERSION
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
