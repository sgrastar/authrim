import {
  decryptObjectArtifact,
  encryptObjectArtifact,
  readR2ObjectTextWithLimit,
  type Env,
} from '@authrim/ar-lib-core';
import {
  writeLoggingMessagePayloadToR2,
  type LoggingMessagePayloadWriteInput,
  type LoggingMessagePayloadWriteResult,
} from '@authrim/ar-lib-logging/messaging';

const ENVELOPE_CONTENT_TYPE = 'application/vnd.authrim.object-envelope+json';

function encryptionKeyVersion(env: Env): number {
  const parsed = Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function writeEncryptedLoggingMessagePayload(
  env: Env,
  input: Omit<LoggingMessagePayloadWriteInput, 'storedPayloadEncoder'>
): Promise<LoggingMessagePayloadWriteResult> {
  if (!env.OBJECT_ENCRYPTION_ROOT_KEY) {
    throw new Error('logging_message_payload_encryption_key_unavailable');
  }
  const tenantContext = input.tenantKey ?? 'platform';
  const keyVersion = encryptionKeyVersion(env);
  return writeLoggingMessagePayloadToR2({
    ...input,
    storedPayloadEncoder: async ({ plaintext, objectRef }) => {
      const envelope = await encryptObjectArtifact(plaintext, {
        rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY!,
        plane: 'AUDIT_ARCHIVE',
        keyVersion,
        contentType: 'application/json',
        context: {
          tenantId: tenantContext,
          objectKey: objectRef,
          objectClass: 'operational_log_detail',
        },
      });
      return {
        body: JSON.stringify(envelope),
        contentType: ENVELOPE_CONTENT_TYPE,
        customMetadata: {
          encryption: 'authrim-object-envelope-v1',
          encryptionTenantContext: tenantContext,
          keyVersion: String(keyVersion),
        },
      };
    },
  });
}

export type EncryptedLoggingMessagePayloadReadResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      reason:
        | 'bucket_unavailable'
        | 'encryption_key_unavailable'
        | 'not_found'
        | 'too_large'
        | 'unencrypted_payload'
        | 'integrity_mismatch'
        | 'malformed_payload';
    };

export async function readEncryptedLoggingMessagePayload(
  env: Env,
  objectRef: string,
  maxBytes: number
): Promise<EncryptedLoggingMessagePayloadReadResult> {
  if (!env.AUDIT_ARCHIVE) return { ok: false, reason: 'bucket_unavailable' };
  if (!env.OBJECT_ENCRYPTION_ROOT_KEY) {
    return { ok: false, reason: 'encryption_key_unavailable' };
  }
  const object = await env.AUDIT_ARCHIVE.get(objectRef);
  if (!object) return { ok: false, reason: 'not_found' };
  const metadata = (object as R2ObjectBody & { customMetadata?: Record<string, string> })
    .customMetadata;
  if (
    metadata?.encryption !== 'authrim-object-envelope-v1' ||
    !metadata.encryptionTenantContext ||
    !metadata.sha256
  ) {
    return { ok: false, reason: 'unencrypted_payload' };
  }
  let stored: string;
  try {
    stored = await readR2ObjectTextWithLimit(object, maxBytes);
  } catch {
    return { ok: false, reason: 'too_large' };
  }
  try {
    const plaintext = await decryptObjectArtifact(JSON.parse(stored), {
      rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
      context: {
        tenantId: metadata.encryptionTenantContext,
        objectKey: objectRef,
        objectClass: 'operational_log_detail',
      },
    });
    if ((await sha256Hex(plaintext)) !== metadata.sha256) {
      return { ok: false, reason: 'integrity_mismatch' };
    }
    return { ok: true, value: JSON.parse(plaintext) as unknown };
  } catch {
    return { ok: false, reason: 'malformed_payload' };
  }
}
