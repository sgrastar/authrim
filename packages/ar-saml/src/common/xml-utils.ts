/**
 * XML Utilities for SAML 2.0
 *
 * Provides XML parsing, generation, and manipulation functions.
 * Uses @xmldom/xmldom for DOM operations.
 */

import { DOMParser, XMLSerializer, DOMImplementation } from '@xmldom/xmldom';
import { SAML_NAMESPACES } from './constants';

export const SAML_XML_LIMITS = {
  maxChars: 256 * 1024,
  maxMarkupTokens: 8192,
  maxNodes: 8192,
  maxDepth: 64,
  maxAttributes: 8192,
} as const;

// Re-export types from xmldom for use in other modules
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type XMLDocument = ReturnType<DOMParser['parseFromString']>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type XMLElement = any;

/**
 * XXE (XML External Entity) attack patterns to detect
 *
 * These patterns detect potentially malicious XML constructs:
 * - DOCTYPE declarations (can define entities)
 * - ENTITY declarations (internal or external)
 * - SYSTEM/PUBLIC external references
 *
 * SAML messages should never contain DOCTYPE or ENTITY declarations.
 *
 * @see https://owasp.org/www-community/vulnerabilities/XML_External_Entity_(XXE)_Processing
 */
const XXE_PATTERNS = {
  /** DOCTYPE declaration - can be used to define entities */
  DOCTYPE: /<!DOCTYPE\s/i,
  /** ENTITY declaration - defines internal or external entities */
  ENTITY: /<!ENTITY\s/i,
  /** SYSTEM keyword - external file/URL reference */
  SYSTEM: /SYSTEM\s+["']/i,
  /** PUBLIC keyword - external DTD reference */
  PUBLIC: /PUBLIC\s+["']/i,
} as const;

/**
 * Validate XML string for XXE attack patterns
 *
 * @param xmlString - XML string to validate
 * @throws Error if XXE attack pattern is detected
 */
function validateXmlSecurity(xmlString: string): void {
  // Check for DOCTYPE (most common XXE vector)
  if (XXE_PATTERNS.DOCTYPE.test(xmlString)) {
    throw new Error('XML security error: DOCTYPE declarations are not allowed in SAML messages');
  }

  // Check for ENTITY declarations (can be inline in DOCTYPE)
  if (XXE_PATTERNS.ENTITY.test(xmlString)) {
    throw new Error('XML security error: ENTITY declarations are not allowed in SAML messages');
  }

  // Check for SYSTEM references (external file access)
  if (XXE_PATTERNS.SYSTEM.test(xmlString)) {
    throw new Error('XML security error: SYSTEM references are not allowed in SAML messages');
  }

  // Check for PUBLIC references (external DTD)
  if (XXE_PATTERNS.PUBLIC.test(xmlString)) {
    throw new Error('XML security error: PUBLIC references are not allowed in SAML messages');
  }
}

/**
 * Parse XML string into DOM Document
 *
 * Security features:
 * - XXE (XML External Entity) attack prevention
 * - DOCTYPE/ENTITY declaration rejection
 * - External reference (SYSTEM/PUBLIC) rejection
 *
 * @param xmlString - XML string to parse
 * @returns Parsed XML document
 * @throws Error if XML is malformed or contains security threats
 */
export function parseXml(xmlString: string): XMLDocument {
  // Security: Validate XML before parsing to prevent XXE attacks
  validateXmlSecurity(xmlString);

  // xmldom 0.8.x types pass a plain string for the level.
  const errorHandler = (level: string, msg: string) => {
    if (level === 'error') {
      throw new Error(`XML Parse Error: ${msg}`);
    } else if (level === 'fatalError') {
      throw new Error(`XML Fatal Error: ${msg}`);
    }
    // Warnings are ignored
  };
  const parser = new DOMParser({ errorHandler });

  const doc = parser.parseFromString(xmlString, 'text/xml');

  // Check for parse errors
  const parseError = doc.getElementsByTagName('parsererror');
  if (parseError.length > 0) {
    throw new Error(`XML Parse Error: ${parseError[0].textContent}`);
  }

  return doc;
}

/**
 * Parse an untrusted SAML protocol message with resource and syntax limits.
 *
 * Processing instructions are forbidden after the optional XML declaration.
 * xml-crypto canonicalization and DOM text extraction do not preserve the same
 * processing-instruction semantics, so accepting them could make the verified
 * bytes differ from the values consumed by protocol code.
 */
export function parseSAMLXml(xmlString: string): XMLDocument {
  if (xmlString.length > SAML_XML_LIMITS.maxChars) {
    throw new Error('SAML XML exceeds maximum size');
  }

  const markupTokens = countOccurrences(xmlString, '<');
  if (markupTokens > SAML_XML_LIMITS.maxMarkupTokens) {
    throw new Error('SAML XML exceeds maximum markup complexity');
  }

  const withoutDeclaration = xmlString.replace(/^\uFEFF?\s*<\?xml(?:\s[^?]*?)?\?>/i, '');
  if (withoutDeclaration.includes('<?')) {
    throw new Error('SAML XML processing instructions are not allowed');
  }

  const doc = parseXml(xmlString);
  validateSAMLDocumentBudget(doc);
  return doc;
}

function countOccurrences(value: string, character: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === character) {
      count++;
    }
  }
  return count;
}

function validateSAMLDocumentBudget(doc: XMLDocument): void {
  const stack: Array<{ node: Node; depth: number }> = [{ node: doc, depth: 0 }];
  let nodeCount = 0;
  let attributeCount = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    nodeCount++;
    if (nodeCount > SAML_XML_LIMITS.maxNodes) {
      throw new Error('SAML XML exceeds maximum node count');
    }
    if (current.depth > SAML_XML_LIMITS.maxDepth) {
      throw new Error('SAML XML exceeds maximum depth');
    }

    if (current.node.nodeType === 1) {
      attributeCount += (current.node as Element).attributes?.length ?? 0;
      if (attributeCount > SAML_XML_LIMITS.maxAttributes) {
        throw new Error('SAML XML exceeds maximum attribute count');
      }
    }

    const children = current.node.childNodes;
    if (!children) continue;
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index];
      if (child) {
        stack.push({ node: child, depth: current.depth + 1 });
      }
    }
  }
}

/**
 * Serialize DOM Document to XML string
 */
export function serializeXml(doc: XMLDocument | XMLElement): string {
  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}

/**
 * Create a new XML Document
 */
export function createDocument(): XMLDocument {
  const impl = new DOMImplementation();
  return impl.createDocument('', '', null);
}

/**
 * Create an element with the given namespace
 */
export function createElement(
  doc: XMLDocument,
  namespace: string,
  localName: string,
  prefix?: string
): XMLElement {
  const qualifiedName = prefix ? `${prefix}:${localName}` : localName;
  return doc.createElementNS(namespace, qualifiedName);
}

/**
 * Set an attribute on an element
 */
export function setAttribute(element: XMLElement, name: string, value: string): void {
  element.setAttribute(name, value);
}

/**
 * Set a namespaced attribute on an element
 */
export function setAttributeNS(
  element: XMLElement,
  namespace: string | null,
  qualifiedName: string,
  value: string
): void {
  element.setAttributeNS(namespace, qualifiedName, value);
}

/**
 * Set element text content
 */
export function setTextContent(element: XMLElement, text: string): void {
  element.textContent = text;
}

/**
 * Get element text content
 */
export function getTextContent(element: XMLElement | null): string | null {
  return element?.textContent ?? null;
}

/**
 * Append child element
 */
export function appendChild(parent: XMLElement | XMLDocument, child: XMLElement): void {
  parent.appendChild(child);
}

/**
 * Find first element by tag name within namespace
 */
export function findElement(
  parent: XMLDocument | XMLElement,
  namespace: string,
  localName: string
): XMLElement | null {
  const elements = parent.getElementsByTagNameNS(namespace, localName);
  return elements.length > 0 ? elements[0] : null;
}

/**
 * Find all elements by tag name within namespace
 */
export function findElements(
  parent: XMLDocument | XMLElement,
  namespace: string,
  localName: string
): XMLElement[] {
  const elements = parent.getElementsByTagNameNS(namespace, localName);
  const result: XMLElement[] = [];
  for (let i = 0; i < elements.length; i++) {
    result.push(elements[i]);
  }
  return result;
}

/**
 * Find a direct child element by namespace/local name.
 *
 * Use this for protocol elements whose position is security-sensitive. A
 * descendant search can accidentally select attacker-controlled nested content.
 */
export function findDirectChildElement(
  parent: XMLDocument | XMLElement,
  namespace: string,
  localName: string
): XMLElement | null {
  const children = parent.childNodes;
  if (!children) {
    return null;
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (
      child?.nodeType === 1 &&
      child.namespaceURI === namespace &&
      child.localName === localName
    ) {
      return child;
    }
  }

  return null;
}

/**
 * Find direct child elements by namespace/local name.
 */
export function findDirectChildElements(
  parent: XMLDocument | XMLElement,
  namespace: string,
  localName: string
): XMLElement[] {
  const children = parent.childNodes;
  const results: XMLElement[] = [];
  if (!children) {
    return results;
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (
      child?.nodeType === 1 &&
      child.namespaceURI === namespace &&
      child.localName === localName
    ) {
      results.push(child);
    }
  }

  return results;
}

/**
 * Get attribute value
 */
export function getAttribute(element: XMLElement, name: string): string | null {
  return element.hasAttribute(name) ? element.getAttribute(name) : null;
}

/**
 * Parse the XML Schema boolean lexical forms used by SAML attributes.
 */
export function parseXmlBoolean(value: string | null | undefined): boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  throw new Error(`Invalid XML boolean value: ${value}`);
}

/**
 * Generate a SAML ID (must start with letter or underscore)
 */
export function generateSAMLId(): string {
  const randomBytes = new Uint8Array(16);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `_${hex}`;
}

/**
 * Format date to ISO 8601 format for SAML (xs:dateTime)
 */
export function formatDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parse ISO 8601 date string
 */
export function parseDateTime(dateStr: string): Date {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }
  return date;
}

/**
 * Get current time as formatted SAML datetime
 */
export function nowAsDateTime(): string {
  return formatDateTime(new Date());
}

/**
 * Calculate datetime offset from now
 */
export function offsetDateTime(seconds: number): string {
  const date = new Date();
  date.setSeconds(date.getSeconds() + seconds);
  return formatDateTime(date);
}

/**
 * XML namespace prefixes commonly used
 */
export const NS_PREFIXES = {
  samlp: SAML_NAMESPACES.SAML2P,
  saml: SAML_NAMESPACES.SAML2,
  md: SAML_NAMESPACES.MD,
  ds: SAML_NAMESPACES.DS,
  xs: SAML_NAMESPACES.XS,
  xsi: SAML_NAMESPACES.XSI,
} as const;

/**
 * Add namespace declarations to root element
 */
export function addNamespaceDeclarations(
  element: XMLElement,
  namespaces: Record<string, string>
): void {
  for (const [prefix, uri] of Object.entries(namespaces)) {
    element.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, uri);
  }
}

/**
 * Base64 encode string
 */
export function base64Encode(str: string): string {
  return base64EncodeBytes(new TextEncoder().encode(str));
}

/**
 * Base64 decode string
 */
export function base64Decode(str: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(base64DecodeToBytes(str));
}

/**
 * Base64 encode raw bytes.
 */
export function base64EncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Base64 decode to raw bytes.
 */
export function base64DecodeToBytes(str: string): Uint8Array {
  return Uint8Array.from(atob(str), (char) => char.charCodeAt(0));
}

/**
 * Base64 URL encode (for HTTP-Redirect binding)
 */
export function base64UrlEncode(str: string): string {
  return base64Encode(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
}

/**
 * Base64 URL decode
 */
export function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if needed
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return base64Decode(base64);
}
