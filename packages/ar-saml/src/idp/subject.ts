import {
  generatePairwiseSubject,
  type Env,
  type NameIDFormat,
  type SAMLAuthnRequest,
  type SAMLSPConfig,
} from '@authrim/ar-lib-core';
import {
  generatePersistentIdentifier,
  type PersistentIdentifierAlgorithm,
  type PersistentIdentifierAudienceMode,
} from '@authrim/ar-lib-core/services/persistent-identifiers';
import { DEFAULTS, NAMEID_FORMATS } from '../common/constants';
import { getKeyManagerSecret } from '../common/key-utils';

export const DEFAULT_SAML_TRANSIENT_NAMEID_TTL_SECONDS = 300;

export interface SAMLSubjectInfo {
  id: string;
  email?: string;
}

export interface SAMLTransientNameIDStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get?(key: string): Promise<string | null>;
  delete?(key: string): Promise<void>;
}

export interface SAMLPersistentNameIDRegistryStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
}

export type SAMLSessionIndexStore = Required<
  Pick<SAMLTransientNameIDStore, 'put' | 'get' | 'delete'>
>;

export interface SAMLNameIDContext {
  tenantId: string;
  spEntityId: string;
  pairwiseSalt?: string;
  pairwiseAlgorithm?: SAMLPersistentIdentifierAlgorithm;
  pairwiseAudienceMode?: PersistentIdentifierAudienceMode;
  persistentProfileId?: string;
  persistentRegistry?: SAMLPersistentNameIDRegistryStore;
  allowCreate?: boolean;
  transientStore?: SAMLTransientNameIDStore;
  transientTtlSeconds?: number;
  sessionId?: string;
}

export type SAMLPersistentIdentifierAlgorithm = PersistentIdentifierAlgorithm;

export interface SAMLPairwiseSaltSource {
  PAIRWISE_SALT?: string;
  KEY_MANAGER?: Env['KEY_MANAGER'];
  KEY_MANAGER_SECRET?: string;
}

export interface SAMLTransientNameIDStoreSource {
  STATE_STORE?: SAMLTransientNameIDStore;
  KV?: SAMLPersistentNameIDRegistryStore;
}

export class SAMLNameIDPolicyError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SAMLNameIDPolicyError';
  }
}

export function resolveSAMLNameIDFormat(
  authnRequest: SAMLAuthnRequest,
  spConfig: Pick<SAMLSPConfig, 'entityId' | 'nameIdFormat'>
): NameIDFormat {
  const spNameQualifier = authnRequest.nameIdPolicy?.spNameQualifier;
  if (spNameQualifier && spNameQualifier !== spConfig.entityId) {
    throw new SAMLNameIDPolicyError('AuthnRequest NameIDPolicy SPNameQualifier is not supported', {
      requested_sp_name_qualifier: spNameQualifier,
      sp_entity_id: spConfig.entityId,
    });
  }

  const format = authnRequest.nameIdPolicy?.format || spConfig.nameIdFormat || NAMEID_FORMATS.EMAIL;
  if (!isSupportedSAMLNameIDFormat(format)) {
    throw new SAMLNameIDPolicyError('AuthnRequest NameIDPolicy Format is not supported', {
      requested_format: format,
      supported_formats: SUPPORTED_SAML_NAMEID_FORMATS,
    });
  }

  return format;
}

export async function resolveSAMLNameIDValue(
  subject: SAMLSubjectInfo,
  nameIdFormat: NameIDFormat,
  context?: SAMLNameIDContext
): Promise<string> {
  switch (nameIdFormat) {
    case NAMEID_FORMATS.EMAIL:
      return requireSAMLSubjectEmail(subject, nameIdFormat);
    case NAMEID_FORMATS.PERSISTENT:
      return resolvePersistentNameID(subject, context);
    case NAMEID_FORMATS.TRANSIENT:
      return resolveTransientNameID(subject, context);
    default:
      return requireSAMLSubjectEmail(subject, nameIdFormat);
  }
}

function requireSAMLSubjectEmail(subject: SAMLSubjectInfo, nameIdFormat: NameIDFormat): string {
  const email = subject.email?.trim();
  if (!email) {
    throw new SAMLNameIDPolicyError('Email is required for the requested SAML NameID format', {
      requested_format: nameIdFormat,
      required_subject_attribute: 'email',
      attribute_present: false,
    });
  }
  return email;
}

export async function resolveSAMLEduPersonTargetedIDOpaque(
  subject: SAMLSubjectInfo,
  context: SAMLNameIDContext
): Promise<string> {
  return resolvePersistentNameID(subject, {
    ...context,
    allowCreate: true,
  });
}

export function resolveSAMLPairwiseSalt(env: SAMLPairwiseSaltSource): string | undefined {
  return env.PAIRWISE_SALT;
}

export async function resolveSAMLPairwiseSecret(
  env: SAMLPairwiseSaltSource,
  tenantId: string
): Promise<string | undefined> {
  return resolveSAMLPairwiseSecretForRef(env, tenantId, buildSAMLPairwiseSecretRef(tenantId));
}

export async function resolveSAMLPairwiseSecretForRef(
  env: SAMLPairwiseSaltSource,
  tenantId: string,
  secretRef: string
): Promise<string | undefined> {
  if (env.KEY_MANAGER && env.KEY_MANAGER_SECRET) {
    const secret = await getKeyManagerSecret(env as Env, tenantId, {
      secretRef,
    });
    return secret.active.value;
  }

  return secretRef === buildSAMLPairwiseSecretRef(tenantId)
    ? resolveSAMLPairwiseSalt(env)
    : undefined;
}

export function resolveSAMLTransientNameIDStore(
  env: SAMLTransientNameIDStoreSource
): SAMLTransientNameIDStore | undefined {
  return env.STATE_STORE;
}

export function resolveSAMLPersistentNameIDRegistryStore(
  env: SAMLTransientNameIDStoreSource
): SAMLPersistentNameIDRegistryStore | undefined {
  return env.KV ?? (env.STATE_STORE as SAMLPersistentNameIDRegistryStore | undefined);
}

export function buildSAMLPairwiseSectorIdentifier(tenantId: string, spEntityId: string): string {
  return JSON.stringify(['saml', tenantId, spEntityId]);
}

export function buildSAMLPairwiseSecretRef(tenantId: string): string {
  return `tenant:${tenantId}:saml:pairwise-nameid`;
}

export function buildSAMLTransientNameIDKey(
  tenantId: string,
  spEntityId: string,
  transientNameId: string
): string {
  return `saml:transient-nameid:tenant:${tenantId}:sp:${encodeURIComponent(spEntityId)}:id:${transientNameId}`;
}

export function buildSAMLPersistentNameIDRegistryKey(
  tenantId: string,
  spEntityId: string,
  subjectId: string
): string {
  return `saml:persistent-nameid:tenant:${tenantId}:sp:${encodeURIComponent(spEntityId)}:subject:${encodeURIComponent(subjectId)}`;
}

export function buildSAMLSessionIndexKey(
  tenantId: string,
  spEntityId: string,
  sessionIndex: string
): string {
  return `saml:session-index:tenant:${tenantId}:sp:${encodeURIComponent(spEntityId)}:id:${sessionIndex}`;
}

export async function createSAMLSessionIndex(
  store: SAMLSessionIndexStore,
  options: {
    tenantId: string;
    spEntityId: string;
    sessionId: string;
    ttlSeconds?: number;
  }
): Promise<string> {
  const sessionIndex = generateSAMLSessionIndex();
  const ttlSeconds = options.ttlSeconds ?? DEFAULTS.SESSION_VALIDITY_SECONDS;
  const issuedAt = Date.now();

  await store.put(
    buildSAMLSessionIndexKey(options.tenantId, options.spEntityId, sessionIndex),
    JSON.stringify({
      version: 1,
      tenantId: options.tenantId,
      spEntityId: options.spEntityId,
      sessionId: options.sessionId,
      issuedAt,
      expiresAt: issuedAt + ttlSeconds * 1000,
    }),
    { expirationTtl: ttlSeconds }
  );

  return sessionIndex;
}

export async function resolveSAMLSessionIndexToSessionId(
  store: Pick<SAMLSessionIndexStore, 'get' | 'delete'>,
  options: {
    tenantId: string;
    spEntityId: string;
    sessionIndex: string;
  }
): Promise<string | null> {
  const key = buildSAMLSessionIndexKey(options.tenantId, options.spEntityId, options.sessionIndex);
  const stored = await store.get(key);
  if (!stored) {
    return null;
  }

  const parsed = parseSAMLSessionIndexRecord(stored);
  if (!parsed || parsed.tenantId !== options.tenantId || parsed.spEntityId !== options.spEntityId) {
    return null;
  }

  if (parsed.expiresAt <= Date.now()) {
    await store.delete(key);
    return null;
  }

  return parsed.sessionId;
}

async function resolvePersistentNameID(
  subject: SAMLSubjectInfo,
  context?: SAMLNameIDContext
): Promise<string> {
  if (!context?.pairwiseSalt) {
    throw new Error('PAIRWISE_SALT is required for persistent SAML NameID');
  }

  const registryKey =
    context.tenantId && context.spEntityId
      ? buildSAMLPersistentNameIDRegistryKey(context.tenantId, context.spEntityId, subject.id)
      : undefined;
  if (context.persistentRegistry && registryKey) {
    const existing = parseSAMLPersistentNameIDRegistryRecord(
      await context.persistentRegistry.get(registryKey)
    );
    if (existing) {
      return existing.nameId;
    }
  }

  if (context.allowCreate === false) {
    throw new SAMLNameIDPolicyError(
      'AuthnRequest NameIDPolicy AllowCreate=false is not satisfied',
      {
        requested_format: NAMEID_FORMATS.PERSISTENT,
        allow_create: false,
        registry_available: Boolean(context.persistentRegistry),
      }
    );
  }

  const audience = buildSAMLPairwiseSectorIdentifier(context.tenantId, context.spEntityId);
  const nameId = await generateSAMLPersistentIdentifier(
    subject.id,
    audience,
    context.pairwiseSalt,
    context.pairwiseAlgorithm
  );
  if (context.persistentRegistry && registryKey) {
    await context.persistentRegistry.put(
      registryKey,
      JSON.stringify({
        version: 1,
        tenantId: context.tenantId,
        spEntityId: context.spEntityId,
        subjectId: subject.id,
        nameId,
        createdAt: Date.now(),
      })
    );
  }

  return nameId;
}

export async function generateSAMLPersistentIdentifier(
  subjectId: string,
  audience: string,
  secret: string,
  algorithm: SAMLPersistentIdentifierAlgorithm = 'authrim_sha256_base64url'
): Promise<string> {
  if (algorithm === 'authrim_sha256_base64url') {
    return generatePairwiseSubject(subjectId, audience, secret);
  }
  return generatePersistentIdentifier({ algorithm, subject: subjectId, audience, secret });
}

async function resolveTransientNameID(
  subject: SAMLSubjectInfo,
  context?: SAMLNameIDContext
): Promise<string> {
  if (!context?.transientStore) {
    throw new Error('STATE_STORE is required for transient SAML NameID');
  }

  const transientNameId = generateTransientNameID();
  const ttlSeconds = context.transientTtlSeconds ?? DEFAULT_SAML_TRANSIENT_NAMEID_TTL_SECONDS;
  const issuedAt = Date.now();

  await context.transientStore.put(
    buildSAMLTransientNameIDKey(context.tenantId, context.spEntityId, transientNameId),
    JSON.stringify({
      version: 1,
      tenantId: context.tenantId,
      spEntityId: context.spEntityId,
      subjectId: subject.id,
      sessionId: context.sessionId,
      issuedAt,
      expiresAt: issuedAt + ttlSeconds * 1000,
    }),
    { expirationTtl: ttlSeconds }
  );

  return transientNameId;
}

function generateTransientNameID(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) {
    return `trn_${randomUUID.call(globalThis.crypto).replace(/-/g, '')}`;
  }

  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const binary = String.fromCharCode(...bytes);
  return `trn_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function generateSAMLSessionIndex(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) {
    return `sidx_${randomUUID.call(globalThis.crypto).replace(/-/g, '')}`;
  }

  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const binary = String.fromCharCode(...bytes);
  return `sidx_${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function parseSAMLSessionIndexRecord(value: string): {
  tenantId: string;
  spEntityId: string;
  sessionId: string;
  expiresAt: number;
} | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.tenantId !== 'string' ||
      typeof parsed.spEntityId !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }

    return {
      tenantId: parsed.tenantId,
      spEntityId: parsed.spEntityId,
      sessionId: parsed.sessionId,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function parseSAMLPersistentNameIDRegistryRecord(value: string | null): {
  nameId: string;
} | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.nameId !== 'string') {
      return null;
    }
    return { nameId: parsed.nameId };
  } catch {
    return null;
  }
}

export const SUPPORTED_SAML_NAMEID_FORMATS = [
  NAMEID_FORMATS.EMAIL,
  NAMEID_FORMATS.PERSISTENT,
  NAMEID_FORMATS.TRANSIENT,
  NAMEID_FORMATS.UNSPECIFIED,
] as const;

function isSupportedSAMLNameIDFormat(value: string): value is NameIDFormat {
  return (SUPPORTED_SAML_NAMEID_FORMATS as readonly string[]).includes(value);
}
