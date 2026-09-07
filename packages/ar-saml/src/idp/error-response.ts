import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { STATUS_CODES } from '../common/constants';
import { generateSAMLId, nowAsDateTime } from '../common/xml-utils';
import type { MissingRequiredSAMLAttribute } from './attributes';
import { buildErrorResponse } from './assertion';
import {
  applySAMLErrorResponseSigningPolicy,
  assertSAMLResponseSigningPolicy,
  type SAMLSigningMaterial,
} from './signing';

export const SAML_ATTRIBUTE_RELEASE_FAILURE_STATUS_MESSAGE =
  'Required SAML attributes could not be released';

export interface SAMLIdPErrorResponseOptions {
  issuer: string;
  destination: string;
  inResponseTo?: string;
  statusCode?: string;
  secondLevelStatusCode?: string;
  statusMessage?: string;
  spConfig?: Pick<SAMLSPConfig, 'signAssertions' | 'signResponses'>;
  signingMaterial?: SAMLSigningMaterial;
}

export interface SAMLErrorResponseStatusInput {
  failureKind?: string;
  statusCode: string;
  secondLevelStatusCode?: string;
  statusMessage: string;
}

export function buildSAMLIdPErrorResponse(options: SAMLIdPErrorResponseOptions): string {
  const xml = buildErrorResponse({
    responseId: generateSAMLId(),
    issueInstant: nowAsDateTime(),
    issuer: options.issuer,
    destination: options.destination,
    inResponseTo: options.inResponseTo,
    statusCode: options.statusCode ?? STATUS_CODES.RESPONDER,
    secondLevelStatusCode: options.secondLevelStatusCode,
    statusMessage: options.statusMessage,
  });

  if (!options.spConfig) {
    return xml;
  }

  assertSAMLResponseSigningPolicy(options.spConfig);
  if (!options.signingMaterial) {
    throw new Error('SAML signing material is required');
  }

  return applySAMLErrorResponseSigningPolicy(xml, options.spConfig, options.signingMaterial);
}

export function getSAMLAttributeReleaseFailureStatusMessage(
  spConfig: Pick<SAMLSPConfig, 'attributeReleaseFailureUserMessageMode'>,
  missingAttributes: MissingRequiredSAMLAttribute[]
): string {
  if (spConfig.attributeReleaseFailureUserMessageMode !== 'detailed') {
    return SAML_ATTRIBUTE_RELEASE_FAILURE_STATUS_MESSAGE;
  }

  const labels = missingAttributes
    .map((attribute) => attribute.friendlyName || attribute.name)
    .filter((label, index, all) => all.indexOf(label) === index);

  if (labels.length === 0) {
    return SAML_ATTRIBUTE_RELEASE_FAILURE_STATUS_MESSAGE;
  }

  return `${SAML_ATTRIBUTE_RELEASE_FAILURE_STATUS_MESSAGE}: ${labels.join(', ')}`;
}

export function applySAMLErrorResponseOverride(
  spConfig: Pick<SAMLSPConfig, 'errorResponseOverrides'>,
  input: SAMLErrorResponseStatusInput
): SAMLErrorResponseStatusInput {
  if (!input.failureKind) {
    return input;
  }

  const override = spConfig.errorResponseOverrides?.find(
    (item) => item.failureKind === input.failureKind
  );
  if (!override) {
    return input;
  }

  return {
    failureKind: input.failureKind,
    statusCode: override.statusCode ?? input.statusCode,
    secondLevelStatusCode:
      override.secondLevelStatusCode === null
        ? undefined
        : (override.secondLevelStatusCode ?? input.secondLevelStatusCode),
    statusMessage: override.statusMessage ?? input.statusMessage,
  };
}
