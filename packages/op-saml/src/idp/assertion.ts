/**
 * SAML Assertion Builder
 *
 * Generates SAML 2.0 Assertions and Responses according to OASIS SAML 2.0 specification.
 */

import { SAML_NAMESPACES, STATUS_CODES, SUBJECT_CONFIRMATION_METHODS } from '../common/constants';
import {
  createDocument,
  createElement,
  setAttribute,
  setAttributeNS,
  setTextContent,
  appendChild,
  addNamespaceDeclarations,
  serializeXml,
  type XMLDocument,
  type XMLElement,
} from '../common/xml-utils';
import type { NameIDFormat } from '@authrim/shared';

/**
 * Options for building SAML Response
 */
export interface SAMLResponseOptions {
  /** Response ID */
  responseId: string;
  /** Assertion ID */
  assertionId: string;
  /** Issue instant (xs:dateTime format) */
  issueInstant: string;
  /** Issuer EntityID */
  issuer: string;
  /** Destination URL (SP's ACS) */
  destination: string;
  /** InResponseTo (AuthnRequest ID) */
  inResponseTo?: string;
  /** Status code */
  statusCode?: string;
  /** Status message */
  statusMessage?: string;
  /** Recipient URL for SubjectConfirmation */
  recipientUrl: string;
  /** Audience restriction (SP EntityID) */
  audienceRestriction: string;
  /** Subject NameID value */
  nameId: string;
  /** Subject NameID format */
  nameIdFormat: NameIDFormat;
  /** Authentication instant */
  authnInstant: string;
  /** Session index */
  sessionIndex?: string;
  /** NotBefore condition */
  notBefore: string;
  /** NotOnOrAfter condition */
  notOnOrAfter: string;
  /** AuthnContext class reference */
  authnContextClassRef: string;
  /** Attribute statements */
  attributes?: Array<{ name: string; nameFormat?: string; values: string[] }>;
}

/**
 * Build SAML Response XML
 */
export function buildSAMLResponse(options: SAMLResponseOptions): string {
  const {
    responseId,
    assertionId,
    issueInstant,
    issuer,
    destination,
    inResponseTo,
    statusCode = STATUS_CODES.SUCCESS,
    statusMessage,
    recipientUrl,
    audienceRestriction,
    nameId,
    nameIdFormat,
    authnInstant,
    sessionIndex,
    notBefore,
    notOnOrAfter,
    authnContextClassRef,
    attributes,
  } = options;

  const doc = createDocument();

  // Create Response element
  const responseElement = createElement(doc, SAML_NAMESPACES.SAML2P, 'Response', 'samlp');
  setAttribute(responseElement, 'ID', responseId);
  setAttribute(responseElement, 'Version', '2.0');
  setAttribute(responseElement, 'IssueInstant', issueInstant);
  setAttribute(responseElement, 'Destination', destination);
  if (inResponseTo) {
    setAttribute(responseElement, 'InResponseTo', inResponseTo);
  }

  // Add namespace declarations
  addNamespaceDeclarations(responseElement, {
    samlp: SAML_NAMESPACES.SAML2P,
    saml: SAML_NAMESPACES.SAML2,
  });

  // Add Issuer
  const issuerElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Issuer', 'saml');
  setTextContent(issuerElement, issuer);
  appendChild(responseElement, issuerElement);

  // Add Status
  const statusElement = createElement(doc, SAML_NAMESPACES.SAML2P, 'Status', 'samlp');
  const statusCodeElement = createElement(doc, SAML_NAMESPACES.SAML2P, 'StatusCode', 'samlp');
  setAttribute(statusCodeElement, 'Value', statusCode);
  appendChild(statusElement, statusCodeElement);

  if (statusMessage) {
    const statusMessageElement = createElement(
      doc,
      SAML_NAMESPACES.SAML2P,
      'StatusMessage',
      'samlp'
    );
    setTextContent(statusMessageElement, statusMessage);
    appendChild(statusElement, statusMessageElement);
  }

  appendChild(responseElement, statusElement);

  // Add Assertion (only if status is Success)
  if (statusCode === STATUS_CODES.SUCCESS) {
    const assertionElement = buildAssertion(doc, {
      assertionId,
      issueInstant,
      issuer,
      recipientUrl,
      audienceRestriction,
      nameId,
      nameIdFormat,
      authnInstant,
      sessionIndex,
      notBefore,
      notOnOrAfter,
      authnContextClassRef,
      inResponseTo,
      attributes,
    });
    appendChild(responseElement, assertionElement);
  }

  // Append to document and serialize
  appendChild(doc, responseElement);

  const xmlString = serializeXml(doc);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlString}`;
}

/**
 * Options for building SAML Assertion
 */
interface AssertionOptions {
  assertionId: string;
  issueInstant: string;
  issuer: string;
  recipientUrl: string;
  audienceRestriction: string;
  nameId: string;
  nameIdFormat: NameIDFormat;
  authnInstant: string;
  sessionIndex?: string;
  notBefore: string;
  notOnOrAfter: string;
  authnContextClassRef: string;
  inResponseTo?: string;
  attributes?: Array<{ name: string; nameFormat?: string; values: string[] }>;
}

/**
 * Build SAML Assertion element
 */
function buildAssertion(doc: XMLDocument, options: AssertionOptions): XMLElement {
  const {
    assertionId,
    issueInstant,
    issuer,
    recipientUrl,
    audienceRestriction,
    nameId,
    nameIdFormat,
    authnInstant,
    sessionIndex,
    notBefore,
    notOnOrAfter,
    authnContextClassRef,
    inResponseTo,
    attributes,
  } = options;

  // Create Assertion element
  const assertionElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Assertion', 'saml');
  setAttribute(assertionElement, 'ID', assertionId);
  setAttribute(assertionElement, 'Version', '2.0');
  setAttribute(assertionElement, 'IssueInstant', issueInstant);

  // Add Issuer
  const issuerElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Issuer', 'saml');
  setTextContent(issuerElement, issuer);
  appendChild(assertionElement, issuerElement);

  // Add Subject
  const subjectElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Subject', 'saml');

  // NameID
  const nameIdElement = createElement(doc, SAML_NAMESPACES.SAML2, 'NameID', 'saml');
  setAttribute(nameIdElement, 'Format', nameIdFormat);
  setTextContent(nameIdElement, nameId);
  appendChild(subjectElement, nameIdElement);

  // SubjectConfirmation
  const subjectConfirmationElement = createElement(
    doc,
    SAML_NAMESPACES.SAML2,
    'SubjectConfirmation',
    'saml'
  );
  setAttribute(subjectConfirmationElement, 'Method', SUBJECT_CONFIRMATION_METHODS.BEARER);

  // SubjectConfirmationData
  const subjectConfirmationDataElement = createElement(
    doc,
    SAML_NAMESPACES.SAML2,
    'SubjectConfirmationData',
    'saml'
  );
  setAttribute(subjectConfirmationDataElement, 'NotOnOrAfter', notOnOrAfter);
  setAttribute(subjectConfirmationDataElement, 'Recipient', recipientUrl);
  if (inResponseTo) {
    setAttribute(subjectConfirmationDataElement, 'InResponseTo', inResponseTo);
  }
  appendChild(subjectConfirmationElement, subjectConfirmationDataElement);
  appendChild(subjectElement, subjectConfirmationElement);

  appendChild(assertionElement, subjectElement);

  // Add Conditions
  const conditionsElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Conditions', 'saml');
  setAttribute(conditionsElement, 'NotBefore', notBefore);
  setAttribute(conditionsElement, 'NotOnOrAfter', notOnOrAfter);

  // AudienceRestriction
  const audienceRestrictionElement = createElement(
    doc,
    SAML_NAMESPACES.SAML2,
    'AudienceRestriction',
    'saml'
  );
  const audienceElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Audience', 'saml');
  setTextContent(audienceElement, audienceRestriction);
  appendChild(audienceRestrictionElement, audienceElement);
  appendChild(conditionsElement, audienceRestrictionElement);

  appendChild(assertionElement, conditionsElement);

  // Add AuthnStatement
  const authnStatementElement = createElement(doc, SAML_NAMESPACES.SAML2, 'AuthnStatement', 'saml');
  setAttribute(authnStatementElement, 'AuthnInstant', authnInstant);
  if (sessionIndex) {
    setAttribute(authnStatementElement, 'SessionIndex', sessionIndex);
  }
  setAttribute(authnStatementElement, 'SessionNotOnOrAfter', notOnOrAfter);

  // AuthnContext
  const authnContextElement = createElement(doc, SAML_NAMESPACES.SAML2, 'AuthnContext', 'saml');
  const authnContextClassRefElement = createElement(
    doc,
    SAML_NAMESPACES.SAML2,
    'AuthnContextClassRef',
    'saml'
  );
  setTextContent(authnContextClassRefElement, authnContextClassRef);
  appendChild(authnContextElement, authnContextClassRefElement);
  appendChild(authnStatementElement, authnContextElement);

  appendChild(assertionElement, authnStatementElement);

  // Add AttributeStatement (if attributes provided)
  if (attributes && attributes.length > 0) {
    const attributeStatementElement = createElement(
      doc,
      SAML_NAMESPACES.SAML2,
      'AttributeStatement',
      'saml'
    );

    for (const attr of attributes) {
      const attributeElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Attribute', 'saml');
      setAttribute(attributeElement, 'Name', attr.name);
      if (attr.nameFormat) {
        setAttribute(attributeElement, 'NameFormat', attr.nameFormat);
      } else {
        // Default to URI name format
        setAttribute(
          attributeElement,
          'NameFormat',
          'urn:oasis:names:tc:SAML:2.0:attrname-format:uri'
        );
      }

      for (const value of attr.values) {
        const attributeValueElement = createElement(
          doc,
          SAML_NAMESPACES.SAML2,
          'AttributeValue',
          'saml'
        );
        setAttributeNS(attributeValueElement, SAML_NAMESPACES.XSI, 'xsi:type', 'xs:string');
        setTextContent(attributeValueElement, value);
        appendChild(attributeElement, attributeValueElement);
      }

      appendChild(attributeStatementElement, attributeElement);
    }

    appendChild(assertionElement, attributeStatementElement);
  }

  return assertionElement;
}

/**
 * Build a SAML error Response
 */
export function buildErrorResponse(options: {
  responseId: string;
  issueInstant: string;
  issuer: string;
  destination: string;
  inResponseTo?: string;
  statusCode: string;
  statusMessage?: string;
}): string {
  return buildSAMLResponse({
    ...options,
    assertionId: '', // Not used for error responses
    recipientUrl: '',
    audienceRestriction: '',
    nameId: '',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
    authnInstant: '',
    notBefore: '',
    notOnOrAfter: '',
    authnContextClassRef: '',
  });
}
