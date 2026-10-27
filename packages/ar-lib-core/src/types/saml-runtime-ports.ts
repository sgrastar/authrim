import type { SAMLIdentityMappingFieldMappingSelector, SAMLRequestData } from './saml';
import type { DestinationProfileConsentDescriptor } from '../services/destination-profile-consent';

/** A compiled IdP release policy and active profile from the same verified Admin snapshot. */
export interface SAMLRuntimeImportedSPRelease {
  tenantId: string;
  entityId: string;
  /** Exact selector stored with the SP; null means the source's active tenant policy was selected. */
  sourceSelector: SAMLIdentityMappingFieldMappingSelector | null;
  sourceBindingRef: {
    activationId: string;
    fieldMappingSetId: string;
    fieldMappingVersionId: string;
    mappingSnapshotHash: string;
    destinationProfileId: string;
    destinationProfileVersionId: string;
  };
  /** The compiled binding; validated again against tenant, SP, and source references at use. */
  binding: unknown;
  destinationProfile: DestinationProfileConsentDescriptor;
}

/**
 * The stateful operations needed by a SAML IdP outside Cloudflare Workers.
 *
 * This is intentionally smaller than a Durable Object or KV namespace. Every operation must
 * preserve tenant and counterparty isolation; request consumption must be atomic and one-use.
 */
export interface SAMLRuntimePorts {
  serviceProviders: {
    /** Only operator-selected, imported explicit SPs may use a limited runtime. */
    isAllowed(input: { tenantId: string; entityId: string }): boolean;
    getRelease(input: { tenantId: string; entityId: string }): SAMLRuntimeImportedSPRelease | null;
  };
  requests: {
    store(input: { tenantId: string; spEntityId: string; request: SAMLRequestData }): Promise<void>;
    consume(input: {
      tenantId: string;
      spEntityId: string;
      requestId: string;
    }): Promise<SAMLRequestData | null>;
  };
  sessions: {
    get(input: { tenantId: string; sessionId: string }): Promise<{
      userId: string;
      createdAt?: number;
      data?: Record<string, unknown>;
    } | null>;
    /** Required before an alternate runtime enables IdP SLO. */
    delete?(input: { tenantId: string; sessionId: string }): Promise<boolean>;
  };
  signing: {
    /** Missing material must reject the request; this port must never rotate automatically. */
    getKey(input: { tenantId: string; keyRef?: string }): Promise<{
      kid: string;
      privateKeyPem: string;
      publicKeyPem: string;
      certificate: string;
    }>;
    getSecret(input: { tenantId: string; secretRef: string }): Promise<{
      secretRef: string;
      active: { kid: string; value: string; createdAt: number };
      previous?: { kid: string; value: string; createdAt: number };
      updatedAt: number;
    }>;
  };
}
