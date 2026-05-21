export type CursorDirection = 'next' | 'previous';

export interface LoggingCursorPayload {
  sort: Record<string, string | number | null>;
  direction: CursorDirection;
  filterHash: string;
  expiresAt: number;
}

export interface LoggingCursorDecodeResult {
  valid: boolean;
  payload?: LoggingCursorPayload;
  reason?: 'malformed' | 'signature_mismatch' | 'expired';
}

const CURSOR_VERSION = 1;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifyPayload(payload: string, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await importSigningKey(secret);
    return crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(signature),
      new TextEncoder().encode(payload)
    );
  } catch {
    return false;
  }
}

function isLoggingCursorPayload(value: unknown): value is LoggingCursorPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Partial<LoggingCursorPayload>;
  const directionIsValid = payload.direction === 'next' || payload.direction === 'previous';
  const filterHashIsValid =
    typeof payload.filterHash === 'string' && payload.filterHash.trim().length > 0;
  const expiresAtIsValid =
    typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt);
  const sortIsValid =
    !!payload.sort &&
    typeof payload.sort === 'object' &&
    !Array.isArray(payload.sort) &&
    Object.values(payload.sort).every(
      (item) => typeof item === 'string' || typeof item === 'number' || item === null
    );

  return directionIsValid && filterHashIsValid && expiresAtIsValid && sortIsValid;
}

export async function encodeLoggingCursor(
  payload: LoggingCursorPayload,
  secret: string
): Promise<string> {
  const envelope = {
    v: CURSOR_VERSION,
    payload,
  };
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(stableJson(envelope)));
  const signature = await signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function decodeLoggingCursor(
  cursor: string,
  secret: string,
  now = Date.now()
): Promise<LoggingCursorDecodeResult> {
  const [encodedPayload, signature, extra] = cursor.split('.');
  if (!encodedPayload || !signature || extra !== undefined) {
    return { valid: false, reason: 'malformed' };
  }

  if (!(await verifyPayload(encodedPayload, signature, secret))) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  try {
    const envelope = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as {
      v?: number;
      payload?: LoggingCursorPayload;
    };
    if (envelope.v !== CURSOR_VERSION || !isLoggingCursorPayload(envelope.payload)) {
      return { valid: false, reason: 'malformed' };
    }
    if (envelope.payload.expiresAt <= now) {
      return { valid: false, reason: 'expired' };
    }
    return {
      valid: true,
      payload: envelope.payload,
    };
  } catch {
    return { valid: false, reason: 'malformed' };
  }
}
