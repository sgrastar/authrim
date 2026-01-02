/**
 * SAML Processing Type Definitions
 *
 * Provides type definitions for XML DOM operations and signature verification
 * used in SAML 2.0 processing. These types are compatible with @xmldom/xmldom
 * and xml-crypto libraries.
 */

// =============================================================================
// XML DOM Types (compatible with @xmldom/xmldom)
// =============================================================================

/**
 * DOM Node type constants
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Node/nodeType
 */
export const NodeType = {
  ELEMENT_NODE: 1,
  ATTRIBUTE_NODE: 2,
  TEXT_NODE: 3,
  CDATA_SECTION_NODE: 4,
  PROCESSING_INSTRUCTION_NODE: 7,
  COMMENT_NODE: 8,
  DOCUMENT_NODE: 9,
  DOCUMENT_TYPE_NODE: 10,
  DOCUMENT_FRAGMENT_NODE: 11,
} as const;

/**
 * Base XML Node interface
 */
export interface XMLNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  parentNode: XMLNode | null;
  childNodes: XMLNodeList;
  firstChild: XMLNode | null;
  lastChild: XMLNode | null;
  previousSibling: XMLNode | null;
  nextSibling: XMLNode | null;
  ownerDocument: XMLDocument | null;
  textContent: string | null;
}

/**
 * XML Node List
 */
export interface XMLNodeList {
  length: number;
  item(index: number): XMLNode | null;
  [index: number]: XMLNode;
}

/**
 * XML Named Node Map (for attributes)
 */
export interface XMLNamedNodeMap {
  length: number;
  item(index: number): XMLAttr | null;
  getNamedItem(name: string): XMLAttr | null;
  getNamedItemNS(namespaceURI: string | null, localName: string): XMLAttr | null;
  [index: number]: XMLAttr;
}

/**
 * XML Attribute
 */
export interface XMLAttr extends XMLNode {
  nodeType: typeof NodeType.ATTRIBUTE_NODE;
  name: string;
  value: string;
  specified: boolean;
  ownerElement: XMLElement | null;
}

/**
 * XML Element
 */
export interface XMLElement extends XMLNode {
  nodeType: typeof NodeType.ELEMENT_NODE;
  tagName: string;
  attributes: XMLNamedNodeMap;
  localName: string;
  namespaceURI: string | null;
  prefix: string | null;
  getAttribute(name: string): string | null;
  getAttributeNS(namespaceURI: string | null, localName: string): string | null;
  getElementsByTagName(tagName: string): XMLNodeList;
  getElementsByTagNameNS(namespaceURI: string, localName: string): XMLNodeList;
  hasAttribute(name: string): boolean;
  hasAttributeNS(namespaceURI: string | null, localName: string): boolean;
}

/**
 * XML Document
 */
export interface XMLDocument extends XMLNode {
  nodeType: typeof NodeType.DOCUMENT_NODE;
  documentElement: XMLElement | null;
  getElementsByTagName(tagName: string): XMLNodeList;
  getElementsByTagNameNS(namespaceURI: string, localName: string): XMLNodeList;
  getElementById(elementId: string): XMLElement | null;
}

// =============================================================================
// xml-crypto Types
// =============================================================================

/**
 * Extended SignedXml interface with validation errors
 *
 * The xml-crypto library's SignedXml class has a validationErrors property
 * that contains error messages when signature verification fails, but this
 * property is not exposed in the library's type definitions.
 */
export interface SignedXmlWithErrors {
  /**
   * Array of validation error messages when checkSignature() returns false
   */
  validationErrors?: string[];
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a node is an Element node
 */
export function isElementNode(node: XMLNode): node is XMLElement {
  return node.nodeType === NodeType.ELEMENT_NODE;
}

/**
 * Check if a node is a Document node
 */
export function isDocumentNode(node: XMLNode): node is XMLDocument {
  return node.nodeType === NodeType.DOCUMENT_NODE;
}

/**
 * Check if a node is a Text node
 */
export function isTextNode(node: XMLNode): boolean {
  return node.nodeType === NodeType.TEXT_NODE;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * SAML XML namespace URIs
 */
export const SAML_NAMESPACES = {
  SAML2_ASSERTION: 'urn:oasis:names:tc:SAML:2.0:assertion',
  SAML2_PROTOCOL: 'urn:oasis:names:tc:SAML:2.0:protocol',
  SAML2_METADATA: 'urn:oasis:names:tc:SAML:2.0:metadata',
  XMLDSIG: 'http://www.w3.org/2000/09/xmldsig#',
  XMLENC: 'http://www.w3.org/2001/04/xmlenc#',
} as const;

/**
 * Result of finding elements by ID in an XML document
 */
export type FindElementsByIdResult = XMLElement[];
