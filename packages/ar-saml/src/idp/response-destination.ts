import type { SAMLAuthnRequest, SAMLSPConfig } from '@authrim/ar-lib-core';
import { BINDING_URIS } from '../common/constants';

export class UnsupportedSAMLResponseBindingError extends Error {
  constructor(
    readonly requestedBinding: string,
    readonly supportedBindings: string[]
  ) {
    super('AuthnRequest ProtocolBinding is not supported by this IdP SSO endpoint');
    this.name = 'UnsupportedSAMLResponseBindingError';
  }
}

export class InvalidSAMLResponseDestinationError extends Error {
  constructor(
    readonly requestedAcsUrl: string,
    readonly allowedAcsUrls: string[],
    readonly requestedAcsIndex?: number
  ) {
    super(
      'AuthnRequest AssertionConsumerServiceURL/Index is not registered for this Service Provider'
    );
    this.name = 'InvalidSAMLResponseDestinationError';
  }
}

export function resolveSAMLResponseDestination(
  authnRequest: SAMLAuthnRequest,
  spConfig: SAMLSPConfig
): string {
  const allowedAcsUrls = getAllowedAcsUrls(spConfig);
  const requestedAcsUrl = authnRequest.assertionConsumerServiceURL;
  const requestedAcsIndex = authnRequest.assertionConsumerServiceIndex;

  if (!requestedAcsUrl) {
    if (requestedAcsIndex !== undefined) {
      const indexedAcs = spConfig.acsServices?.find(
        (service) => service.index === requestedAcsIndex
      );
      if (!indexedAcs || !allowedAcsUrls.includes(indexedAcs.location)) {
        throw new InvalidSAMLResponseDestinationError(
          `index:${requestedAcsIndex}`,
          allowedAcsUrls,
          requestedAcsIndex
        );
      }
      return indexedAcs.location;
    }

    return spConfig.acsUrl;
  }

  if (!allowedAcsUrls.includes(requestedAcsUrl)) {
    throw new InvalidSAMLResponseDestinationError(requestedAcsUrl, allowedAcsUrls);
  }

  return requestedAcsUrl;
}

export function validateSAMLResponseProtocolBinding(authnRequest: SAMLAuthnRequest): void {
  const requestedBinding = authnRequest.protocolBinding;
  if (!requestedBinding || requestedBinding === BINDING_URIS.HTTP_POST) {
    return;
  }

  throw new UnsupportedSAMLResponseBindingError(requestedBinding, [BINDING_URIS.HTTP_POST]);
}

function getAllowedAcsUrls(spConfig: SAMLSPConfig): string[] {
  return Array.from(new Set([spConfig.acsUrl, ...(spConfig.acsUrls ?? [])].filter(Boolean)));
}
