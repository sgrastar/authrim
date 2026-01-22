/**
 * SAML Single Logout (SLO) Message Builders
 *
 * Generates SAML 2.0 LogoutRequest and LogoutResponse messages.
 */

import { SAML_NAMESPACES, STATUS_CODES } from './constants';
import {
  createDocument,
  createElement,
  setAttribute,
  setTextContent,
  appendChild,
  addNamespaceDeclarations,
  serializeXml,
  parseXml,
  findElement,
  findElements,
  getAttribute,
  getTextContent,
  base64Decode,
} from './xml-utils';
import type { NameIDFormat } from '@authrim/ar-lib-core';
import * as pako from 'pako';

/**
 * Options for building LogoutRequest
 */
export interface LogoutRequestOptions {
  /** Request ID */
  id: string;
  /** Issue instant (xs:dateTime format) */
  issueInstant: string;
  /** Issuer EntityID */
  issuer: string;
  /** Destination URL */
  destination: string;
  /** Subject NameID value */
  nameId: string;
  /** Subject NameID format */
  nameIdFormat: NameIDFormat;
  /** Session index to terminate */
  sessionIndex?: string;
  /** Reason for logout */
  reason?: string;
  /** NotOnOrAfter - request expiry */
  notOnOrAfter?: string;
}

/**
 * Options for building LogoutResponse
 */
export interface LogoutResponseOptions {
  /** Response ID */
  id: string;
  /** Issue instant (xs:dateTime format) */
  issueInstant: string;
  /** Issuer EntityID */
  issuer: string;
  /** Destination URL */
  destination: string;
  /** InResponseTo (LogoutRequest ID) */
  inResponseTo: string;
  /** Status code */
  statusCode?: string;
  /** Status message */
  statusMessage?: string;
}

/**
 * Parsed LogoutRequest data
 */
export interface ParsedLogoutRequest {
  id: string;
  issueInstant: string;
  issuer: string;
  destination?: string;
  nameId: string;
  nameIdFormat?: string;
  /** First SessionIndex (for backward compatibility) */
  sessionIndex?: string;
  /** All SessionIndex elements (SAML 2.0 allows multiple) */
  sessionIndices?: string[];
  notOnOrAfter?: string;
}

/**
 * Parsed LogoutResponse data
 */
export interface ParsedLogoutResponse {
  id: string;
  issueInstant: string;
  issuer: string;
  destination?: string;
  inResponseTo?: string;
  statusCode: string;
  statusMessage?: string;
}

/**
 * Build SAML LogoutRequest XML
 */
export function buildLogoutRequest(options: LogoutRequestOptions): string {
  const {
    id,
    issueInstant,
    issuer,
    destination,
    nameId,
    nameIdFormat,
    sessionIndex,
    reason,
    notOnOrAfter,
  } = options;

  const doc = createDocument();

  // Create LogoutRequest element
  const logoutRequestElement = createElement(doc, SAML_NAMESPACES.SAML2P, 'LogoutRequest', 'samlp');
  setAttribute(logoutRequestElement, 'ID', id);
  setAttribute(logoutRequestElement, 'Version', '2.0');
  setAttribute(logoutRequestElement, 'IssueInstant', issueInstant);
  setAttribute(logoutRequestElement, 'Destination', destination);

  if (reason) {
    setAttribute(logoutRequestElement, 'Reason', reason);
  }

  if (notOnOrAfter) {
    setAttribute(logoutRequestElement, 'NotOnOrAfter', notOnOrAfter);
  }

  // Add namespace declarations
  addNamespaceDeclarations(logoutRequestElement, {
    samlp: SAML_NAMESPACES.SAML2P,
    saml: SAML_NAMESPACES.SAML2,
  });

  // Add Issuer
  const issuerElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Issuer', 'saml');
  setTextContent(issuerElement, issuer);
  appendChild(logoutRequestElement, issuerElement);

  // Add NameID
  const nameIdElement = createElement(doc, SAML_NAMESPACES.SAML2, 'NameID', 'saml');
  setAttribute(nameIdElement, 'Format', nameIdFormat);
  setTextContent(nameIdElement, nameId);
  appendChild(logoutRequestElement, nameIdElement);

  // Add SessionIndex (if provided)
  if (sessionIndex) {
    const sessionIndexElement = createElement(doc, SAML_NAMESPACES.SAML2P, 'SessionIndex', 'samlp');
    setTextContent(sessionIndexElement, sessionIndex);
    appendChild(logoutRequestElement, sessionIndexElement);
  }

  // Append to document and serialize
  appendChild(doc, logoutRequestElement);

  const xmlString = serializeXml(doc);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlString}`;
}

/**
 * Build SAML LogoutResponse XML
 */
export function buildLogoutResponse(options: LogoutResponseOptions): string {
  const {
    id,
    issueInstant,
    issuer,
    destination,
    inResponseTo,
    statusCode = STATUS_CODES.SUCCESS,
    statusMessage,
  } = options;

  const doc = createDocument();

  // Create LogoutResponse element
  const logoutResponseElement = createElement(
    doc,
    SAML_NAMESPACES.SAML2P,
    'LogoutResponse',
    'samlp'
  );
  setAttribute(logoutResponseElement, 'ID', id);
  setAttribute(logoutResponseElement, 'Version', '2.0');
  setAttribute(logoutResponseElement, 'IssueInstant', issueInstant);
  setAttribute(logoutResponseElement, 'Destination', destination);
  setAttribute(logoutResponseElement, 'InResponseTo', inResponseTo);

  // Add namespace declarations
  addNamespaceDeclarations(logoutResponseElement, {
    samlp: SAML_NAMESPACES.SAML2P,
    saml: SAML_NAMESPACES.SAML2,
  });

  // Add Issuer
  const issuerElement = createElement(doc, SAML_NAMESPACES.SAML2, 'Issuer', 'saml');
  setTextContent(issuerElement, issuer);
  appendChild(logoutResponseElement, issuerElement);

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

  appendChild(logoutResponseElement, statusElement);

  // Append to document and serialize
  appendChild(doc, logoutResponseElement);

  const xmlString = serializeXml(doc);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xmlString}`;
}

/**
 * Parse LogoutRequest from HTTP-POST binding (Base64)
 */
export function parseLogoutRequestPost(samlRequestBase64: string): ParsedLogoutRequest {
  const xml = base64Decode(samlRequestBase64);
  return parseLogoutRequestXml(xml);
}

/**
 * Parse LogoutRequest from HTTP-Redirect binding (Deflate + Base64)
 */
export function parseLogoutRequestRedirect(samlRequestEncoded: string): ParsedLogoutRequest {
  const base64Decoded = base64Decode(samlRequestEncoded);
  const inflated = pako.inflateRaw(
    Uint8Array.from(base64Decoded, (c) => c.charCodeAt(0)),
    {
      to: 'string',
    }
  );
  return parseLogoutRequestXml(inflated);
}

/**
 * Parse LogoutRequest XML
 */
export function parseLogoutRequestXml(xml: string): ParsedLogoutRequest {
  const doc = parseXml(xml);
  const logoutRequestElement = findElement(doc, SAML_NAMESPACES.SAML2P, 'LogoutRequest');

  if (!logoutRequestElement) {
    throw new Error('Invalid LogoutRequest: missing LogoutRequest element');
  }

  const id = getAttribute(logoutRequestElement, 'ID');
  const issueInstant = getAttribute(logoutRequestElement, 'IssueInstant');
  const destination = getAttribute(logoutRequestElement, 'Destination');
  const notOnOrAfter = getAttribute(logoutRequestElement, 'NotOnOrAfter');

  if (!id || !issueInstant) {
    throw new Error('Invalid LogoutRequest: missing required attributes');
  }

  // Parse Issuer
  const issuerElement = findElement(logoutRequestElement, SAML_NAMESPACES.SAML2, 'Issuer');
  const issuer = getTextContent(issuerElement);

  if (!issuer) {
    throw new Error('Invalid LogoutRequest: missing Issuer');
  }

  // Parse NameID
  const nameIdElement = findElement(logoutRequestElement, SAML_NAMESPACES.SAML2, 'NameID');
  if (!nameIdElement) {
    throw new Error('Invalid LogoutRequest: missing NameID');
  }

  const nameId = getTextContent(nameIdElement) || '';
  const nameIdFormat = getAttribute(nameIdElement, 'Format') || undefined;

  // Parse SessionIndex (optional, can have multiple per SAML 2.0 spec)
  const sessionIndexElements = findElements(
    logoutRequestElement,
    SAML_NAMESPACES.SAML2P,
    'SessionIndex'
  );

  // Extract all session indices
  const sessionIndices: string[] = [];
  for (const element of sessionIndexElements) {
    const value = getTextContent(element);
    if (value) {
      sessionIndices.push(value);
    }
  }

  // First session index for backward compatibility
  const sessionIndex = sessionIndices.length > 0 ? sessionIndices[0] : undefined;

  return {
    id,
    issueInstant,
    issuer,
    destination: destination || undefined,
    nameId,
    nameIdFormat,
    sessionIndex,
    sessionIndices: sessionIndices.length > 0 ? sessionIndices : undefined,
    notOnOrAfter: notOnOrAfter || undefined,
  };
}

/**
 * Parse LogoutResponse from HTTP-POST binding (Base64)
 */
export function parseLogoutResponsePost(samlResponseBase64: string): ParsedLogoutResponse {
  const xml = base64Decode(samlResponseBase64);
  return parseLogoutResponseXml(xml);
}

/**
 * Parse LogoutResponse from HTTP-Redirect binding (Deflate + Base64)
 */
export function parseLogoutResponseRedirect(samlResponseEncoded: string): ParsedLogoutResponse {
  const base64Decoded = base64Decode(samlResponseEncoded);
  const inflated = pako.inflateRaw(
    Uint8Array.from(base64Decoded, (c) => c.charCodeAt(0)),
    {
      to: 'string',
    }
  );
  return parseLogoutResponseXml(inflated);
}

/**
 * Parse LogoutResponse XML
 */
export function parseLogoutResponseXml(xml: string): ParsedLogoutResponse {
  const doc = parseXml(xml);
  const logoutResponseElement = findElement(doc, SAML_NAMESPACES.SAML2P, 'LogoutResponse');

  if (!logoutResponseElement) {
    throw new Error('Invalid LogoutResponse: missing LogoutResponse element');
  }

  const id = getAttribute(logoutResponseElement, 'ID');
  const issueInstant = getAttribute(logoutResponseElement, 'IssueInstant');
  const destination = getAttribute(logoutResponseElement, 'Destination');
  const inResponseTo = getAttribute(logoutResponseElement, 'InResponseTo');

  if (!id || !issueInstant) {
    throw new Error('Invalid LogoutResponse: missing required attributes');
  }

  // Parse Issuer
  const issuerElement = findElement(logoutResponseElement, SAML_NAMESPACES.SAML2, 'Issuer');
  const issuer = getTextContent(issuerElement);

  if (!issuer) {
    throw new Error('Invalid LogoutResponse: missing Issuer');
  }

  // Parse Status
  const statusElement = findElement(logoutResponseElement, SAML_NAMESPACES.SAML2P, 'Status');
  if (!statusElement) {
    throw new Error('Invalid LogoutResponse: missing Status');
  }

  const statusCodeElement = findElement(statusElement, SAML_NAMESPACES.SAML2P, 'StatusCode');
  const statusCode = getAttribute(statusCodeElement!, 'Value') || '';

  const statusMessageElement = findElement(statusElement, SAML_NAMESPACES.SAML2P, 'StatusMessage');
  const statusMessage = statusMessageElement
    ? getTextContent(statusMessageElement) || undefined
    : undefined;

  return {
    id,
    issueInstant,
    issuer,
    destination: destination || undefined,
    inResponseTo: inResponseTo || undefined,
    statusCode,
    statusMessage,
  };
}

/**
 * Encode LogoutRequest/Response for HTTP-POST binding
 */
export function encodeForPostBinding(xml: string): string {
  return btoa(xml);
}

/**
 * Encode LogoutRequest/Response for HTTP-Redirect binding
 */
export function encodeForRedirectBinding(xml: string): string {
  const deflated = pako.deflateRaw(xml);
  return btoa(String.fromCharCode(...deflated))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/, '');
}
