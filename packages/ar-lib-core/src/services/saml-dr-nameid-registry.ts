import type { Env } from '../types/env';
import { getSessionRevocationStore } from './session-revocation-store';

export interface SamlDrNameIdAccountIdentity {
  tenantId: string;
  userId: string;
  accountId: string;
}

export interface SamlDrNameIdRegistryInitialization extends SamlDrNameIdAccountIdentity {
  /** Only a provisioning caller that knows the account is new may set this. */
  freshAccount: true;
  initializationId: string;
  initializedAtMs: number;
}

export interface SamlDrNameIdRecordIdentity extends SamlDrNameIdAccountIdentity {
  spEntityId: string;
  registryKey: string;
}

const TENANT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const USER = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/u;
const KEY = /^saml:persistent-nameid:tenant:(.+):sp:([^:]+):subject:([^:]+)$/u;
const MAX_VALUE_BYTES = 16 * 1024;

function invalid(): never {
  throw new Error('saml_dr_nameid_invalid');
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function validateSamlDrNameIdAccount(
  input: SamlDrNameIdAccountIdentity
): SamlDrNameIdAccountIdentity {
  if (
    !input ||
    typeof input.tenantId !== 'string' ||
    !TENANT.test(input.tenantId) ||
    typeof input.userId !== 'string' ||
    !USER.test(input.userId) ||
    typeof input.accountId !== 'string' ||
    !TENANT.test(input.accountId) ||
    input.accountId !== `account:${input.userId}`
  )
    invalid();
  return { tenantId: input.tenantId, userId: input.userId, accountId: input.accountId };
}

export function parseSamlDrNameIdRegistryKey(registryKey: string): SamlDrNameIdRecordIdentity {
  if (typeof registryKey !== 'string' || registryKey.length > 2048) invalid();
  const match = KEY.exec(registryKey);
  if (!match) invalid();
  let spEntityId: string;
  let userId: string;
  try {
    spEntityId = decodeURIComponent(match[2]);
    userId = decodeURIComponent(match[3]);
  } catch {
    return invalid();
  }
  const identity = validateSamlDrNameIdAccount({
    tenantId: match[1],
    userId,
    accountId: `account:${userId}`,
  });
  if (
    !spEntityId ||
    spEntityId.length > 1024 ||
    hasControlCharacter(spEntityId) ||
    registryKey !==
      `saml:persistent-nameid:tenant:${identity.tenantId}:sp:${encodeURIComponent(spEntityId)}:subject:${encodeURIComponent(userId)}`
  )
    invalid();
  return { ...identity, spEntityId, registryKey };
}

export function validateSamlDrNameIdRecord(
  registryKey: string,
  valueJson: string
): SamlDrNameIdRecordIdentity & { nameId: string; createdAtMs: number } {
  const identity = parseSamlDrNameIdRegistryKey(registryKey);
  if (
    typeof valueJson !== 'string' ||
    new TextEncoder().encode(valueJson).byteLength > MAX_VALUE_BYTES
  )
    invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson) as unknown;
  } catch {
    return invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const item = parsed as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !==
      'createdAt,nameId,spEntityId,subjectId,tenantId,version' ||
    item.version !== 1 ||
    item.tenantId !== identity.tenantId ||
    item.spEntityId !== identity.spEntityId ||
    item.subjectId !== identity.userId ||
    typeof item.nameId !== 'string' ||
    !item.nameId ||
    item.nameId.length > 4096 ||
    hasControlCharacter(item.nameId) ||
    typeof item.createdAt !== 'number' ||
    !Number.isSafeInteger(item.createdAt) ||
    item.createdAt < 1
  )
    invalid();
  return { ...identity, nameId: item.nameId, createdAtMs: item.createdAt };
}

/** Explicit opt-in only. Missing authority rejects; no KV read, fallback or automatic migration. */
export function createSamlDrPersistentNameIdRegistry(
  env: Pick<Env, 'SESSION_REVOCATION_STORE' | 'AUTH_RUNTIME_PORTS'> & {
    ENABLE_SAML_DR_EXPORT?: string;
  }
): {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
} {
  if (env.ENABLE_SAML_DR_EXPORT !== 'true' || env.AUTH_RUNTIME_PORTS)
    throw new Error('saml_dr_nameid_unavailable');
  return {
    async get(registryKey) {
      const identity = parseSamlDrNameIdRegistryKey(registryKey);
      const result = await getSessionRevocationStore(
        env,
        identity.tenantId,
        identity.userId
      ).getSamlDrNameIdRpc(identity);
      if (result !== null) validateSamlDrNameIdRecord(registryKey, result);
      return result;
    },
    async put(registryKey, valueJson, options) {
      if (options?.expirationTtl !== undefined) throw new Error('saml_dr_nameid_ttl_unsupported');
      const identity = validateSamlDrNameIdRecord(registryKey, valueJson);
      await getSessionRevocationStore(env, identity.tenantId, identity.userId).putSamlDrNameIdRpc({
        tenantId: identity.tenantId,
        userId: identity.userId,
        accountId: identity.accountId,
        registryKey,
        valueJson,
      });
    },
  };
}
