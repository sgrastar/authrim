/**
 * XML Utilities Tests
 */
import { describe, it, expect } from 'vitest';
import {
  parseXml,
  serializeXml,
  createDocument,
  createElement,
  setAttribute,
  setTextContent,
  appendChild,
  findElement,
  getAttribute,
  getTextContent,
  generateSAMLId,
  formatDateTime,
  parseDateTime,
  base64Encode,
  base64Decode,
  base64UrlEncode,
  base64UrlDecode,
} from './xml-utils';
import { SAML_NAMESPACES } from './constants';

describe('XML Utilities', () => {
  describe('parseXml', () => {
    it('should parse valid XML', () => {
      const xml = '<?xml version="1.0"?><root><child>text</child></root>';
      const doc = parseXml(xml);
      expect(doc).toBeDefined();
      expect(doc.documentElement?.tagName).toBe('root');
    });

    it('should throw on invalid XML', () => {
      const xml = '<root><unclosed>';
      expect(() => parseXml(xml)).toThrow();
    });
  });

  describe('createDocument and createElement', () => {
    it('should create document with namespaced elements', () => {
      const doc = createDocument();
      const root = createElement(doc, SAML_NAMESPACES.SAML2P, 'AuthnRequest', 'samlp');
      setAttribute(root, 'ID', '_test123');
      appendChild(doc, root);

      const xml = serializeXml(doc);
      expect(xml).toContain('samlp:AuthnRequest');
      expect(xml).toContain('ID="_test123"');
    });

    it('should set text content correctly', () => {
      const doc = createDocument();
      const root = createElement(doc, SAML_NAMESPACES.SAML2, 'Issuer', 'saml');
      setTextContent(root, 'https://example.com');
      appendChild(doc, root);

      const xml = serializeXml(doc);
      expect(xml).toContain('https://example.com');
    });
  });

  describe('findElement and getAttribute', () => {
    it('should find elements by namespace and name', () => {
      const xml = `
        <samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_abc123">
          <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://sp.example.com</saml:Issuer>
        </samlp:AuthnRequest>
      `;
      const doc = parseXml(xml);

      const issuer = findElement(doc, SAML_NAMESPACES.SAML2, 'Issuer');
      expect(issuer).toBeDefined();
      expect(getTextContent(issuer)).toBe('https://sp.example.com');

      const request = findElement(doc, SAML_NAMESPACES.SAML2P, 'AuthnRequest');
      expect(request).toBeDefined();
      expect(getAttribute(request!, 'ID')).toBe('_abc123');
    });
  });

  describe('generateSAMLId', () => {
    it('should generate unique IDs starting with underscore', () => {
      const id1 = generateSAMLId();
      const id2 = generateSAMLId();

      expect(id1).toMatch(/^_[a-f0-9]{32}$/);
      expect(id2).toMatch(/^_[a-f0-9]{32}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('formatDateTime and parseDateTime', () => {
    it('should format date to ISO 8601 without milliseconds', () => {
      const date = new Date('2024-01-15T10:30:00.123Z');
      const formatted = formatDateTime(date);
      expect(formatted).toBe('2024-01-15T10:30:00Z');
    });

    it('should parse ISO 8601 date strings', () => {
      const dateStr = '2024-01-15T10:30:00Z';
      const date = parseDateTime(dateStr);
      expect(date.getTime()).toBe(new Date(dateStr).getTime());
    });

    it('should throw on invalid date strings', () => {
      expect(() => parseDateTime('invalid')).toThrow('Invalid date format');
    });
  });

  describe('Base64 encoding/decoding', () => {
    it('should encode and decode base64', () => {
      const original = 'Hello, SAML!';
      const encoded = base64Encode(original);
      const decoded = base64Decode(encoded);
      expect(decoded).toBe(original);
    });

    it('should encode and decode base64url', () => {
      const original = 'Test with special chars: +/=';
      const encoded = base64UrlEncode(original);
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');

      const decoded = base64UrlDecode(encoded);
      expect(decoded).toBe(original);
    });
  });
});
