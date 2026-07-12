export interface GeneratedTotpBackupCode {
  code: string;
  prefix: string;
  hash: string;
}

const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BACKUP_CODE_LENGTH = 12;

function randomBackupCode(): string {
  const bytes = new Uint8Array(BACKUP_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const byte of bytes) {
    raw += BACKUP_CODE_ALPHABET[byte % BACKUP_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export function normalizeTotpBackupCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export async function hashTotpBackupCode(input: {
  tenantId: string;
  userId: string;
  code: string;
  secret: string;
}): Promise<string> {
  const normalized = normalizeTotpBackupCode(input.code);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`totp-backup:${input.tenantId}:${input.userId}:${normalized}`)
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function generateTotpBackupCodes(input: {
  tenantId: string;
  userId: string;
  secret: string;
  count?: number;
}): Promise<GeneratedTotpBackupCode[]> {
  const count = input.count ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error('Invalid TOTP backup code count');
  }

  const generated: GeneratedTotpBackupCode[] = [];
  const seen = new Set<string>();
  while (generated.length < count) {
    const code = randomBackupCode();
    const normalized = normalizeTotpBackupCode(code);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    generated.push({
      code,
      prefix: normalized.slice(0, 4),
      hash: await hashTotpBackupCode({
        tenantId: input.tenantId,
        userId: input.userId,
        code,
        secret: input.secret,
      }),
    });
  }
  return generated;
}
