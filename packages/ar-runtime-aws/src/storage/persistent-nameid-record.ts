const KEY =
  /^saml:persistent-nameid:tenant:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?):sp:([^:]+):subject:([^:]+)$/u;
const MAX_VALUE_BYTES = 16 * 1024;

export interface SAMLPersistentNameIDRecordIdentity {
  tenantId: string;
  spEntityId: string;
  subjectId: string;
}

export interface SAMLPersistentNameIDRegistryKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

function invalid(): never {
  throw new Error('aws_persistent_nameid_invalid');
}

export function persistentNameIDIdentity(key: string): SAMLPersistentNameIDRecordIdentity {
  const match = KEY.exec(key);
  if (!match || key.length > 2048) invalid();
  let spEntityId: string;
  let subjectId: string;
  try {
    spEntityId = decodeURIComponent(match[2]);
    subjectId = decodeURIComponent(match[3]);
  } catch {
    return invalid();
  }
  if (
    !spEntityId ||
    !subjectId ||
    key !==
      `saml:persistent-nameid:tenant:${match[1]}:sp:${encodeURIComponent(spEntityId)}:subject:${encodeURIComponent(subjectId)}`
  ) {
    invalid();
  }
  return { tenantId: match[1], spEntityId, subjectId };
}

/** Validate a source NameID record without querying or mutating storage. */
export function validateSAMLPersistentNameIDRecord(
  key: string,
  value: string
): SAMLPersistentNameIDRecordIdentity & { createdAt: number } {
  const bound = persistentNameIDIdentity(key);
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) invalid();
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return invalid();
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    decoded.version !== 1 ||
    decoded.tenantId !== bound.tenantId ||
    decoded.spEntityId !== bound.spEntityId ||
    decoded.subjectId !== bound.subjectId ||
    typeof decoded.nameId !== 'string' ||
    !decoded.nameId ||
    decoded.nameId.length > 4096 ||
    !Number.isSafeInteger(decoded.createdAt) ||
    (decoded.createdAt as number) <= 0
  ) {
    invalid();
  }
  return { ...bound, createdAt: decoded.createdAt as number };
}
