/**
 * AWS composition for the existing SAML IdP handlers. Protocol state uses explicit storage ports;
 * signing material is imported explicitly and is never generated on a login request.
 */

import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
  type JsonWebKey,
} from 'node:crypto';
import type { AuthRuntimePorts } from '@authrim/ar-lib-core/types/auth-runtime-ports';
import type {
  SAMLRuntimeImportedSPRelease,
  SAMLRuntimePorts,
} from '@authrim/ar-lib-core/types/saml-runtime-ports';
import type { TransientStateStore } from './storage/state-ports';

/** A decrypted local-signing DR bundle is structurally assignable to this type. */
export interface SAMLRuntimeSigningBundle {
  tenantId: string;
  keys: Array<{
    keyRef: string;
    kid: string;
    privateKeyPem: string;
    certificate: string;
    publicJWK?: unknown;
    certificateSha256Thumbprint?: string;
  }>;
}

export interface SAMLRuntimeImportedSecret {
  tenantId: string;
  secretRef: string;
  active: { kid: string; value: string; createdAt: number };
  previous?: { kid: string; value: string; createdAt: number };
  updatedAt: number;
}

export interface CreateSAMLRuntimePortsInput {
  state: TransientStateStore;
  /** Reuse the auth runtime's lifecycle- and revocation-validated session reader. */
  authSessions: AuthRuntimePorts['sessions'];
  signingBundles: SAMLRuntimeSigningBundle[];
  /** Must include each tenant's current pairwise NameID secret. */
  secrets: SAMLRuntimeImportedSecret[];
  /** Entity IDs of explicit, imported SPs supported by this limited runtime. */
  serviceProviders: Array<{ tenantId: string; entityIds: readonly string[] }>;
  /** One compiled release policy per selected SP from the verified Admin snapshot. */
  serviceProviderReleases: readonly SAMLRuntimeImportedSPRelease[];
}

type ImportedKey = Awaited<ReturnType<SAMLRuntimePorts['signing']['getKey']>> & {
  notBefore: number;
  notAfter: number;
};

function assertTenantBoundRef(ref: string, tenantId: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(tenantId)) {
    throw new Error('Invalid SAML runtime tenant ID');
  }
  if (!ref.startsWith(`tenant:${tenantId}:`) || ref.length <= `tenant:${tenantId}:`.length) {
    throw new Error('SAML runtime reference must be tenant-scoped');
  }
}

function keyMapId(tenantId: string, keyRef: string): string {
  return JSON.stringify([tenantId, keyRef]);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function samePublicKey(
  left: ReturnType<typeof createPublicKey>,
  right: ReturnType<typeof createPublicKey>
): boolean {
  const leftDer = left.export({ type: 'spki', format: 'der' });
  const rightDer = right.export({ type: 'spki', format: 'der' });
  return leftDer.length === rightDer.length && timingSafeEqual(leftDer, rightDer);
}

function prepareKey(
  tenantId: string,
  input: SAMLRuntimeSigningBundle['keys'][number]
): ImportedKey {
  assertTenantBoundRef(input.keyRef, tenantId);
  if (!input.kid || !input.privateKeyPem || !input.certificate) {
    throw new Error('SAML runtime signing key is incomplete');
  }

  const privateKey = createPrivateKey(input.privateKeyPem);
  if (
    privateKey.asymmetricKeyType !== 'rsa' ||
    (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error('SAML runtime signing key must be RSA with at least 2048 bits');
  }
  const certificate = new X509Certificate(input.certificate);
  const publicKey = createPublicKey(privateKey);
  if (!samePublicKey(publicKey, certificate.publicKey)) {
    throw new Error('SAML runtime private key and certificate do not match');
  }
  if (input.publicJWK !== undefined) {
    const jwkPublicKey = createPublicKey({ key: input.publicJWK as JsonWebKey, format: 'jwk' });
    if (!samePublicKey(publicKey, jwkPublicKey)) {
      throw new Error('SAML runtime public JWK and certificate do not match');
    }
  }
  if (input.certificateSha256Thumbprint) {
    const actual = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
    const expected = input.certificateSha256Thumbprint.replaceAll(':', '').toLowerCase();
    if (actual !== expected) {
      throw new Error('SAML runtime certificate thumbprint does not match');
    }
  }

  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notBefore >= notAfter) {
    throw new Error('SAML runtime certificate validity is invalid');
  }

  return {
    kid: input.kid,
    privateKeyPem: input.privateKeyPem,
    publicKeyPem: certificate.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    certificate: input.certificate,
    notBefore,
    notAfter,
  };
}

function prepareSecret(input: SAMLRuntimeImportedSecret): SAMLRuntimeImportedSecret {
  assertTenantBoundRef(input.secretRef, input.tenantId);
  for (const material of [input.active, input.previous].filter(
    (value): value is SAMLRuntimeImportedSecret['active'] => value !== undefined
  )) {
    if (
      !material.kid ||
      !material.value ||
      !Number.isSafeInteger(material.createdAt) ||
      material.createdAt <= 0
    ) {
      throw new Error('SAML runtime secret is incomplete');
    }
  }
  if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt <= 0) {
    throw new Error('SAML runtime secret update time is invalid');
  }
  return {
    tenantId: input.tenantId,
    secretRef: input.secretRef,
    active: { ...input.active },
    ...(input.previous ? { previous: { ...input.previous } } : {}),
    updatedAt: input.updatedAt,
  };
}

/**
 * Build the narrow SAML runtime port from imported material and atomic PostgreSQL state.
 * Construction validates key/certificate correspondence. Each lookup rechecks expiration.
 */
export function createSAMLRuntimePorts(input: CreateSAMLRuntimePortsInput): SAMLRuntimePorts {
  if (input.signingBundles.length === 0) throw new Error('SAML runtime signing bundle required');
  const signingKeys = new Map<string, ImportedKey>();
  const secrets = new Map<string, SAMLRuntimeImportedSecret>();
  const tenantIds = new Set<string>();
  const serviceProviders = new Map<string, Set<string>>();
  const serviceProviderReleases = new Map<string, SAMLRuntimeImportedSPRelease>();
  for (const bundle of input.signingBundles) {
    if (tenantIds.has(bundle.tenantId) || bundle.keys.length === 0) {
      throw new Error('SAML runtime signing bundle is incomplete or duplicated');
    }
    tenantIds.add(bundle.tenantId);
    for (const keyInput of bundle.keys) {
      const key = prepareKey(bundle.tenantId, keyInput);
      const mapId = keyMapId(bundle.tenantId, keyInput.keyRef);
      if (signingKeys.has(mapId)) throw new Error('Duplicate SAML runtime signing key');
      signingKeys.set(mapId, key);
    }
  }
  for (const secretInput of input.secrets) {
    const secret = prepareSecret(secretInput);
    const mapId = keyMapId(secret.tenantId, secret.secretRef);
    if (secrets.has(mapId)) throw new Error('Duplicate SAML runtime secret');
    secrets.set(mapId, secret);
  }
  for (const tenantId of tenantIds) {
    if (!secrets.has(keyMapId(tenantId, `tenant:${tenantId}:saml:pairwise-nameid`))) {
      throw new Error('SAML runtime pairwise NameID secret is unavailable');
    }
  }
  for (const inventory of input.serviceProviders) {
    if (
      !tenantIds.has(inventory.tenantId) ||
      serviceProviders.has(inventory.tenantId) ||
      inventory.entityIds.length === 0
    ) {
      throw new Error('SAML runtime service provider inventory is invalid');
    }
    const entities = new Set<string>();
    for (const entityId of inventory.entityIds) {
      if (
        !entityId.trim() ||
        entityId.length > 2048 ||
        hasControlCharacter(entityId) ||
        entities.has(entityId)
      ) {
        throw new Error('SAML runtime service provider entity ID is invalid');
      }
      entities.add(entityId);
    }
    serviceProviders.set(inventory.tenantId, entities);
  }
  if (serviceProviders.size !== tenantIds.size) {
    throw new Error('SAML runtime service provider inventory is incomplete');
  }
  for (const release of input.serviceProviderReleases) {
    const id = keyMapId(release.tenantId, release.entityId);
    if (
      !serviceProviders.get(release.tenantId)?.has(release.entityId) ||
      serviceProviderReleases.has(id)
    ) {
      throw new Error('SAML runtime imported release inventory is invalid');
    }
    serviceProviderReleases.set(id, release);
  }
  if (
    [...serviceProviders].some(([tenantId, entities]) =>
      [...entities].some((entityId) => !serviceProviderReleases.has(keyMapId(tenantId, entityId)))
    )
  ) {
    throw new Error('SAML runtime imported release inventory is incomplete');
  }

  return {
    serviceProviders: {
      isAllowed: ({ tenantId, entityId }) => serviceProviders.get(tenantId)?.has(entityId) === true,
      getRelease: ({ tenantId, entityId }) =>
        serviceProviderReleases.get(keyMapId(tenantId, entityId)) ?? null,
    },
    requests: {
      store: (request) => input.state.storeSamlRequest(request),
      consume: (request) => input.state.consumeSamlRequest(request),
    },
    sessions: {
      async get(request) {
        const session = await input.authSessions
          .forSession(request)
          .getSessionRpc(request.sessionId);
        if (!session) return null;
        if (
          session.id !== request.sessionId ||
          session.tenantId !== request.tenantId ||
          !session.userId
        ) {
          throw new Error('SAML runtime session binding invalid');
        }
        return { userId: session.userId, createdAt: session.createdAt, data: session.data };
      },
    },
    signing: {
      async getKey({ tenantId, keyRef }) {
        const resolvedRef = keyRef ?? `tenant:${tenantId}:saml:idp:signing`;
        assertTenantBoundRef(resolvedRef, tenantId);
        const key = signingKeys.get(keyMapId(tenantId, resolvedRef));
        if (!key) throw new Error('SAML runtime signing key is unavailable');
        const now = Date.now();
        if (now < key.notBefore || now > key.notAfter) {
          throw new Error('SAML runtime signing certificate is not currently valid');
        }
        return {
          kid: key.kid,
          privateKeyPem: key.privateKeyPem,
          publicKeyPem: key.publicKeyPem,
          certificate: key.certificate,
        };
      },
      async getSecret({ tenantId, secretRef }) {
        assertTenantBoundRef(secretRef, tenantId);
        const secret = secrets.get(keyMapId(tenantId, secretRef));
        if (!secret) throw new Error('SAML runtime secret is unavailable');
        return {
          secretRef,
          active: { ...secret.active },
          ...(secret.previous ? { previous: { ...secret.previous } } : {}),
          updatedAt: secret.updatedAt,
        };
      },
    },
  };
}

/**
 * KV-shaped adapter for the SAML protocol's short-lived NameID/session-index state.
 * All accepted keys embed a tenant ID, and writes require an explicit finite TTL.
 * The persistent NameID registry must use a separate durable store.
 */
export function createSAMLTransientStateKV(state: TransientStateStore): {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
} {
  function tenantIdForKey(key: string): string {
    const match = /^saml:[a-z-]+:tenant:([a-z0-9-]+):/.exec(key);
    if (!match) throw new Error('SAML transient key must be tenant-scoped');
    const tenantId = match[1];
    assertTenantBoundRef(`tenant:${tenantId}:state`, tenantId);
    return tenantId;
  }
  return {
    async get(key) {
      return state.getKey({ tenantId: tenantIdForKey(key), key });
    },
    async put(key, value, options) {
      const ttlSeconds = options?.expirationTtl;
      if (!Number.isSafeInteger(ttlSeconds) || !ttlSeconds || ttlSeconds <= 0) {
        throw new Error('SAML transient state requires a positive expirationTtl');
      }
      await state.putKey({ tenantId: tenantIdForKey(key), key, value, ttlMs: ttlSeconds * 1000 });
    },
    async delete(key) {
      await state.deleteKey({ tenantId: tenantIdForKey(key), key });
    },
  };
}
