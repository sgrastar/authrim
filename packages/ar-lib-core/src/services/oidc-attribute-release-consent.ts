import type {
  AttributeReleaseConsentMode,
  AttributeReleaseConsentPolicy,
} from './identity-release-consent';
import type { ClientMetadata } from '../types/oidc';
import type { Env } from '../types/env';
import { AttributeReleaseConsentRepository } from '../repositories/identity/attribute-release-consent';
import { evaluateReleaseConsentGate } from './identity-release-consent';
import { resolveAuthCorePersistenceAdapterFromEnv } from './auth-core-persistence-context';

export const OIDC_ATTRIBUTE_RELEASE_CONSENT_MODES = new Set<AttributeReleaseConsentMode>([
  'once',
  'every_time',
  'until_attributes_change',
]);
const OIDC_ATTRIBUTE_RELEASE_TRANSACTION_WINDOW_MS = 5 * 60 * 1000;

export interface OIDCAttributeReleaseConsentCheckResult {
  action: 'release';
  claimSetHash: string | null;
  reasonCodes: string[];
}

export class OIDCAttributeReleaseConsentRequiredError extends Error {
  readonly claimSetHash: string;
  readonly reasonCodes: string[];
  readonly consentMode: AttributeReleaseConsentMode;
  readonly claimNames: string[];

  constructor(input: {
    claimSetHash: string;
    reasonCodes: string[];
    consentMode: AttributeReleaseConsentMode;
    claimNames: string[];
  }) {
    super('OIDC claim release consent is required');
    this.name = 'OIDCAttributeReleaseConsentRequiredError';
    this.claimSetHash = input.claimSetHash;
    this.reasonCodes = input.reasonCodes;
    this.consentMode = input.consentMode;
    this.claimNames = input.claimNames;
  }
}

export function normalizeAttributeReleaseConsentPolicy(
  value: unknown
): AttributeReleaseConsentPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const source = value as Record<string, unknown>;
  const mode = source.mode;
  if (
    mode !== undefined &&
    !OIDC_ATTRIBUTE_RELEASE_CONSENT_MODES.has(mode as AttributeReleaseConsentMode)
  ) {
    return null;
  }
  return {
    enabled: source.enabled === true,
    mode: (mode as AttributeReleaseConsentMode | undefined) ?? 'once',
  };
}

export async function enforceOIDCAttributeReleaseConsent(input: {
  env: Env;
  tenantId: string;
  subjectId: string;
  clientMetadata: ClientMetadata;
  claims: Record<string, unknown>;
  target: 'id_token' | 'userinfo';
}): Promise<OIDCAttributeReleaseConsentCheckResult> {
  const policy = normalizeAttributeReleaseConsentPolicy(
    input.clientMetadata.attribute_release_consent
  );
  const releasableClaims = Object.fromEntries(
    Object.entries(input.claims).filter(([claimName]) => isUserDataClaim(claimName))
  );

  if (!policy?.enabled || Object.keys(releasableClaims).length === 0) {
    return { action: 'release', claimSetHash: null, reasonCodes: [] };
  }

  const claimSetHash = await buildOIDCClaimSetHash(releasableClaims);
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
    input.env,
    'oidc-attribute-release-consent'
  );
  const repository = new AttributeReleaseConsentRepository(adapter);
  const existingConsent =
    policy.mode === 'until_attributes_change'
      ? ((await repository.findGrantedConsent({
          tenant_id: input.tenantId,
          subject_id: input.subjectId,
          destination_type: 'oidc_client',
          destination_id: input.clientMetadata.client_id,
          attribute_set_hash: claimSetHash,
        })) ??
        (await repository.findLatestGrantedConsentForDestination({
          tenant_id: input.tenantId,
          subject_id: input.subjectId,
          destination_type: 'oidc_client',
          destination_id: input.clientMetadata.client_id,
        })))
      : await repository.findLatestGrantedConsentForDestination({
          tenant_id: input.tenantId,
          subject_id: input.subjectId,
          destination_type: 'oidc_client',
          destination_id: input.clientMetadata.client_id,
        });
  const effectiveConsent =
    existingConsent ??
    (policy.mode === 'once' ||
    policy.mode === 'every_time' ||
    policy.mode === 'until_attributes_change'
      ? await grantFromExistingOAuthClientConsent({
          repository,
          adapter,
          tenantId: input.tenantId,
          subjectId: input.subjectId,
          clientId: input.clientMetadata.client_id,
          claimSetHash,
          consentMode: policy.mode,
          requireRecentGrant: policy.mode !== 'once',
        })
      : null);

  if (
    policy.mode === 'every_time' &&
    effectiveConsent?.consent_state === 'granted' &&
    effectiveConsent.attribute_set_hash === claimSetHash &&
    effectiveConsent.last_confirmed_at !== null &&
    Date.now() - effectiveConsent.last_confirmed_at <= OIDC_ATTRIBUTE_RELEASE_TRANSACTION_WINDOW_MS
  ) {
    return {
      action: 'release',
      claimSetHash,
      reasonCodes: ['release.attribute_consent.transaction_confirmed'],
    };
  }

  const decision = evaluateReleaseConsentGate({
    fieldRef: {
      namespace: 'oidc.claim',
      path: '*',
      destinationType: 'oidc_client',
      destinationId: input.clientMetadata.client_id,
    },
    legalBasis: 'consent',
    consentSatisfied: true,
    attributeRelease: {
      mode: policy.mode,
      currentAttributeSetHash: claimSetHash,
      existingConsentState: normalizeAttributeReleaseConsentState(effectiveConsent?.consent_state),
      existingAttributeSetHash: effectiveConsent?.attribute_set_hash ?? null,
      consentRecordId: effectiveConsent?.consent_record_id ?? null,
    },
    traceMetadata: {
      protocol: 'oidc',
      target: input.target,
      claimCount: Object.keys(releasableClaims).length,
    },
  });

  if (decision.action === 'challenge') {
    throw new OIDCAttributeReleaseConsentRequiredError({
      claimSetHash,
      reasonCodes: decision.reasonCodes,
      consentMode: policy.mode,
      claimNames: Object.keys(releasableClaims).sort(),
    });
  }

  return {
    action: 'release',
    claimSetHash,
    reasonCodes: decision.reasonCodes,
  };
}

async function grantFromExistingOAuthClientConsent(input: {
  repository: AttributeReleaseConsentRepository;
  adapter: Awaited<ReturnType<typeof resolveAuthCorePersistenceAdapterFromEnv>>;
  tenantId: string;
  subjectId: string;
  clientId: string;
  claimSetHash: string;
  consentMode: AttributeReleaseConsentMode;
  requireRecentGrant?: boolean;
}) {
  const row = await input.adapter.queryOne<{
    id: string;
    granted_at: number;
    expires_at: number | null;
  }>(
    `SELECT id, granted_at, expires_at
       FROM oauth_client_consents
      WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [input.tenantId, input.subjectId, input.clientId]
  );
  if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) {
    return null;
  }
  if (
    input.requireRecentGrant === true &&
    Date.now() - row.granted_at > OIDC_ATTRIBUTE_RELEASE_TRANSACTION_WINDOW_MS
  ) {
    return null;
  }

  return input.repository.grant({
    tenant_id: input.tenantId,
    subject_id: input.subjectId,
    destination_type: 'oidc_client',
    destination_id: input.clientId,
    attribute_set_hash: input.claimSetHash,
    consent_mode: input.consentMode,
    consent_record_id: row.id,
  });
}

export async function buildOIDCClaimSetHash(claims: Record<string, unknown>): Promise<string> {
  const canonical = await Promise.all(
    Object.entries(claims).map(async ([name, value]) => ({
      name,
      valueHash: `sha256:${await sha256Hex(JSON.stringify(normalizeClaimValue(value)))}`,
    }))
  );
  canonical.sort((left, right) => left.name.localeCompare(right.name));
  const digest = await sha256Hex(JSON.stringify(canonical));
  return `sha256:${digest}`;
}

function isUserDataClaim(claimName: string): boolean {
  return (
    ![
      'iss',
      'sub',
      'aud',
      'exp',
      'iat',
      'nbf',
      'jti',
      'nonce',
      'at_hash',
      'c_hash',
      's_hash',
      'sid',
      'azp',
      'auth_time',
      'acr',
      'amr',
    ].includes(claimName) && !claimName.startsWith('authrim_internal_')
  );
}

function normalizeClaimValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeClaimValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeClaimValue(nested)])
    );
  }
  return value;
}

function normalizeAttributeReleaseConsentState(
  value: string | undefined
): 'granted' | 'denied' | 'revoked' | 'expired' | null {
  return value === 'granted' || value === 'denied' || value === 'revoked' || value === 'expired'
    ? value
    : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
