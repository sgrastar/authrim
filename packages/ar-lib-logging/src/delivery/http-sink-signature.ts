export type HttpSinkTimestampFormat = 'unix_seconds' | 'iso8601';
export type HttpSinkSignatureValueFormat = 'sha256_hex' | 'hex';
export type HttpSinkSignatureProfileName = 'authrim' | 'webhook_legacy' | 'custom';

export interface HttpSinkSignatureProfile {
  name: HttpSinkSignatureProfileName;
  signatureHeader: string;
  timestampHeader: string;
  deliveryIdHeader?: string;
  signatureVersionHeader?: string;
  signatureVersion?: string;
  timestampFormat: HttpSinkTimestampFormat;
  signatureValueFormat: HttpSinkSignatureValueFormat;
}

export interface HttpSinkSignatureInput {
  method: string;
  path: string;
  body: string | Uint8Array;
  secret: string;
  deliveryId?: string;
  now?: Date;
  profile?: Partial<HttpSinkSignatureProfile>;
}

export interface HttpSinkSignatureResult {
  headers: Record<string, string>;
  timestamp: string;
  bodySha256Hex: string;
  canonicalString: string;
}

const DEFAULT_AUTHRIM_PROFILE: HttpSinkSignatureProfile = {
  name: 'authrim',
  signatureHeader: 'X-Authrim-Signature-256',
  timestampHeader: 'X-Authrim-Timestamp',
  deliveryIdHeader: 'X-Authrim-Delivery',
  signatureVersionHeader: 'X-Authrim-Signature-Version',
  signatureVersion: 'v1',
  timestampFormat: 'unix_seconds',
  signatureValueFormat: 'sha256_hex',
};

const WEBHOOK_LEGACY_PROFILE: HttpSinkSignatureProfile = {
  name: 'webhook_legacy',
  signatureHeader: 'X-Webhook-Signature',
  timestampHeader: 'X-Webhook-Timestamp',
  deliveryIdHeader: 'X-Webhook-Delivery',
  timestampFormat: 'unix_seconds',
  signatureValueFormat: 'sha256_hex',
};

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function getHttpSinkSignatureProfile(
  name: HttpSinkSignatureProfileName = 'authrim',
  overrides: Partial<HttpSinkSignatureProfile> = {}
): HttpSinkSignatureProfile {
  const base =
    name === 'webhook_legacy'
      ? WEBHOOK_LEGACY_PROFILE
      : name === 'custom'
        ? DEFAULT_AUTHRIM_PROFILE
        : DEFAULT_AUTHRIM_PROFILE;
  return {
    ...base,
    ...overrides,
    name,
  };
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', toBytes(value)));
}

export function formatHttpSinkTimestamp(now: Date, format: HttpSinkTimestampFormat): string {
  if (format === 'iso8601') {
    return now.toISOString();
  }
  return Math.floor(now.getTime() / 1000).toString();
}

export function createHttpSinkCanonicalString(input: {
  timestamp: string;
  method: string;
  path: string;
  bodySha256Hex: string;
}): string {
  return [input.timestamp, input.method.toUpperCase(), input.path, input.bodySha256Hex].join('\n');
}

async function hmacSha256Hex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

export async function signHttpSinkPayload(
  input: HttpSinkSignatureInput
): Promise<HttpSinkSignatureResult> {
  const profile = getHttpSinkSignatureProfile(input.profile?.name, input.profile);
  const timestamp = formatHttpSinkTimestamp(input.now ?? new Date(), profile.timestampFormat);
  const bodySha256Hex = await sha256Hex(input.body);
  const canonicalString = createHttpSinkCanonicalString({
    timestamp,
    method: input.method,
    path: input.path,
    bodySha256Hex,
  });
  const signatureHex = await hmacSha256Hex(canonicalString, input.secret);
  const signatureValue =
    profile.signatureValueFormat === 'sha256_hex' ? `sha256=${signatureHex}` : signatureHex;
  const headers: Record<string, string> = {
    [profile.timestampHeader]: timestamp,
    [profile.signatureHeader]: signatureValue,
  };
  if (profile.signatureVersionHeader && profile.signatureVersion) {
    headers[profile.signatureVersionHeader] = profile.signatureVersion;
  }
  if (profile.deliveryIdHeader && input.deliveryId) {
    headers[profile.deliveryIdHeader] = input.deliveryId;
  }

  return {
    headers,
    timestamp,
    bodySha256Hex,
    canonicalString,
  };
}
