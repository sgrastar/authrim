/**
 * SAML Assertion Builder Tests
 */
import { describe, it, expect } from 'vitest';
import { buildSAMLResponse, buildErrorResponse } from './assertion';
import { parseXml, findElement, getAttribute, getTextContent } from '../common/xml-utils';
import { SAML_NAMESPACES, STATUS_CODES } from '../common/constants';

describe('SAML Assertion Builder', () => {
  const baseOptions = {
    responseId: '_response123',
    assertionId: '_assertion456',
    issueInstant: '2024-01-15T10:30:00Z',
    issuer: 'https://idp.example.com',
    destination: 'https://sp.example.com/acs',
    inResponseTo: '_request789',
    recipientUrl: 'https://sp.example.com/acs',
    audienceRestriction: 'https://sp.example.com',
    nameId: 'user@example.com',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' as const,
    authnInstant: '2024-01-15T10:30:00Z',
    sessionIndex: '_session123',
    notBefore: '2024-01-15T10:29:00Z',
    notOnOrAfter: '2024-01-15T10:35:00Z',
    authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
  };

  describe('buildSAMLResponse', () => {
    it('should build a valid SAML Response with Assertion', () => {
      const xml = buildSAMLResponse(baseOptions);

      expect(xml).toContain('<?xml version="1.0"');

      const doc = parseXml(xml);

      // Check Response element
      const response = findElement(doc, SAML_NAMESPACES.SAML2P, 'Response');
      expect(response).toBeDefined();
      expect(getAttribute(response!, 'ID')).toBe('_response123');
      expect(getAttribute(response!, 'Destination')).toBe('https://sp.example.com/acs');
      expect(getAttribute(response!, 'InResponseTo')).toBe('_request789');

      // Check Issuer
      const issuer = findElement(response!, SAML_NAMESPACES.SAML2, 'Issuer');
      expect(issuer).toBeDefined();
      expect(getTextContent(issuer)).toBe('https://idp.example.com');

      // Check Status
      const statusCode = findElement(response!, SAML_NAMESPACES.SAML2P, 'StatusCode');
      expect(statusCode).toBeDefined();
      expect(getAttribute(statusCode!, 'Value')).toBe(STATUS_CODES.SUCCESS);

      // Check Assertion
      const assertion = findElement(response!, SAML_NAMESPACES.SAML2, 'Assertion');
      expect(assertion).toBeDefined();
      expect(getAttribute(assertion!, 'ID')).toBe('_assertion456');

      // Check Subject/NameID
      const nameId = findElement(assertion!, SAML_NAMESPACES.SAML2, 'NameID');
      expect(nameId).toBeDefined();
      expect(getTextContent(nameId)).toBe('user@example.com');
      expect(getAttribute(nameId!, 'Format')).toBe(
        'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
      );

      // Check Conditions
      const conditions = findElement(assertion!, SAML_NAMESPACES.SAML2, 'Conditions');
      expect(conditions).toBeDefined();
      expect(getAttribute(conditions!, 'NotBefore')).toBe('2024-01-15T10:29:00Z');
      expect(getAttribute(conditions!, 'NotOnOrAfter')).toBe('2024-01-15T10:35:00Z');

      // Check Audience
      const audience = findElement(assertion!, SAML_NAMESPACES.SAML2, 'Audience');
      expect(audience).toBeDefined();
      expect(getTextContent(audience)).toBe('https://sp.example.com');

      // Check AuthnStatement
      const authnStatement = findElement(assertion!, SAML_NAMESPACES.SAML2, 'AuthnStatement');
      expect(authnStatement).toBeDefined();
      expect(getAttribute(authnStatement!, 'SessionIndex')).toBe('_session123');
    });

    it('should include attributes when provided', () => {
      const optionsWithAttrs = {
        ...baseOptions,
        attributes: [
          { name: 'email', values: ['user@example.com'] },
          { name: 'displayName', values: ['Test User'] },
        ],
      };

      const xml = buildSAMLResponse(optionsWithAttrs);
      const doc = parseXml(xml);

      const assertion = findElement(doc, SAML_NAMESPACES.SAML2, 'Assertion');
      const attrStatement = findElement(assertion!, SAML_NAMESPACES.SAML2, 'AttributeStatement');
      expect(attrStatement).toBeDefined();

      // Check attributes are present
      expect(xml).toContain('Name="email"');
      expect(xml).toContain('Name="displayName"');
      expect(xml).toContain('user@example.com');
      expect(xml).toContain('Test User');
    });

    it('should not include assertion for error status', () => {
      const errorOptions = {
        ...baseOptions,
        statusCode: STATUS_CODES.RESPONDER,
        statusMessage: 'Authentication failed',
      };

      const xml = buildSAMLResponse(errorOptions);
      const doc = parseXml(xml);

      // Check Status
      const statusCode = findElement(doc, SAML_NAMESPACES.SAML2P, 'StatusCode');
      expect(getAttribute(statusCode!, 'Value')).toBe(STATUS_CODES.RESPONDER);

      // Check StatusMessage
      const statusMessage = findElement(doc, SAML_NAMESPACES.SAML2P, 'StatusMessage');
      expect(statusMessage).toBeDefined();
      expect(getTextContent(statusMessage)).toBe('Authentication failed');

      // No Assertion for error response
      const assertion = findElement(doc, SAML_NAMESPACES.SAML2, 'Assertion');
      expect(assertion).toBeNull();
    });
  });

  describe('buildErrorResponse', () => {
    it('should build error response with correct status code', () => {
      const xml = buildErrorResponse({
        responseId: '_error123',
        issueInstant: '2024-01-15T10:30:00Z',
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/acs',
        inResponseTo: '_request789',
        statusCode: STATUS_CODES.REQUEST_DENIED,
        statusMessage: 'Request was denied',
      });

      const doc = parseXml(xml);
      const statusCode = findElement(doc, SAML_NAMESPACES.SAML2P, 'StatusCode');
      expect(getAttribute(statusCode!, 'Value')).toBe(STATUS_CODES.REQUEST_DENIED);
    });
  });
});
