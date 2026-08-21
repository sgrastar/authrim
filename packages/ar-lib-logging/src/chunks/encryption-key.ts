import type { LogPlane, LogType } from '../registry';

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/u.test(hex)) {
    throw new Error('object_encryption_root_key_invalid');
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

export async function deriveLogChunkEncryptionKey(input: {
  rootKeyHex: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  keyVersion: number;
}): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    hexToBytes(input.rootKeyHex),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('authrim-log-chunk-archive-encryption'),
      info: new TextEncoder().encode(
        `${input.tenantKey}:${input.logType}:${input.plane}:v${input.keyVersion}`
      ),
    },
    material,
    256
  );
  return new Uint8Array(bits);
}
