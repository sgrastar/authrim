/**
 * SLO Message Builder Tests
 */
import { describe, it, expect } from 'vitest';
import {
  buildLogoutRequest,
  buildLogoutResponse,
  parseLogoutRequestXml,
  parseLogoutResponseXml,
  encodeForPostBinding,
} from './slo-messages';
import { parseXml, findElement, getAttribute, getTextContent } from './xml-utils';
import { SAML_NAMESPACES, STATUS_CODES } from './constants';

describe('SLO Message Builder', () => {
  describe('buildLogoutRequest', () => {
    it('should build a valid LogoutRequest', () => {
      const xml = buildLogoutRequest({
        id: '_logout_req_123',
        issueInstant: '2024-01-15T10:30:00Z',
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        sessionIndex: '_session_456',
      });

      expect(xml).toContain('<?xml version="1.0"');

      const doc = parseXml(xml);

      // Check LogoutRequest element
      const logoutRequest = findElement(doc, SAML_NAMESPACES.SAML2P, 'LogoutRequest');
      expect(logoutRequest).toBeDefined();
      expect(getAttribute(logoutRequest!, 'ID')).toBe('_logout_req_123');
      expect(getAttribute(logoutRequest!, 'Destination')).toBe('https://idp.example.com/slo');

      // Check Issuer
      const issuer = findElement(logoutRequest!, SAML_NAMESPACES.SAML2, 'Issuer');
      expect(getTextContent(issuer)).toBe('https://sp.example.com');

      // Check NameID
      const nameId = findElement(logoutRequest!, SAML_NAMESPACES.SAML2, 'NameID');
      expect(getTextContent(nameId)).toBe('user@example.com');
      expect(getAttribute(nameId!, 'Format')).toBe(
        'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
      );

      // Check SessionIndex
      const sessionIndex = findElement(logoutRequest!, SAML_NAMESPACES.SAML2P, 'SessionIndex');
      expect(getTextContent(sessionIndex)).toBe('_session_456');
    });

    it('should build LogoutRequest without optional fields', () => {
      const xml = buildLogoutRequest({
        id: '_logout_req_789',
        issueInstant: '2024-01-15T10:30:00Z',
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'user@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      });

      const doc = parseXml(xml);
      const logoutRequest = findElement(doc, SAML_NAMESPACES.SAML2P, 'LogoutRequest');

      // SessionIndex should not be present
      const sessionIndex = findElement(logoutRequest!, SAML_NAMESPACES.SAML2P, 'SessionIndex');
      expect(sessionIndex).toBeNull();
    });
  });

  describe('buildLogoutResponse', () => {
    it('should build a success LogoutResponse', () => {
      const xml = buildLogoutResponse({
        id: '_logout_resp_123',
        issueInstant: '2024-01-15T10:30:00Z',
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_req_456',
        statusCode: STATUS_CODES.SUCCESS,
      });

      expect(xml).toContain('<?xml version="1.0"');

      const doc = parseXml(xml);

      // Check LogoutResponse element
      const logoutResponse = findElement(doc, SAML_NAMESPACES.SAML2P, 'LogoutResponse');
      expect(logoutResponse).toBeDefined();
      expect(getAttribute(logoutResponse!, 'ID')).toBe('_logout_resp_123');
      expect(getAttribute(logoutResponse!, 'InResponseTo')).toBe('_logout_req_456');

      // Check Status
      const statusCode = findElement(logoutResponse!, SAML_NAMESPACES.SAML2P, 'StatusCode');
      expect(getAttribute(statusCode!, 'Value')).toBe(STATUS_CODES.SUCCESS);
    });

    it('should build an error LogoutResponse with message', () => {
      const xml = buildLogoutResponse({
        id: '_logout_resp_789',
        issueInstant: '2024-01-15T10:30:00Z',
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_logout_req_000',
        statusCode: STATUS_CODES.RESPONDER,
        statusMessage: 'Session not found',
      });

      const doc = parseXml(xml);

      const statusCode = findElement(doc, SAML_NAMESPACES.SAML2P, 'StatusCode');
      expect(getAttribute(statusCode!, 'Value')).toBe(STATUS_CODES.RESPONDER);

      const statusMessage = findElement(doc, SAML_NAMESPACES.SAML2P, 'StatusMessage');
      expect(getTextContent(statusMessage)).toBe('Session not found');
    });
  });

  describe('parseLogoutRequestXml', () => {
    it('should parse a LogoutRequest XML', () => {
      const xml = buildLogoutRequest({
        id: '_parse_test_123',
        issueInstant: '2024-01-15T10:30:00Z',
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/slo',
        nameId: 'test@example.com',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        sessionIndex: '_session_abc',
      });

      const parsed = parseLogoutRequestXml(xml);

      expect(parsed.id).toBe('_parse_test_123');
      expect(parsed.issueInstant).toBe('2024-01-15T10:30:00Z');
      expect(parsed.issuer).toBe('https://sp.example.com');
      expect(parsed.destination).toBe('https://idp.example.com/slo');
      expect(parsed.nameId).toBe('test@example.com');
      expect(parsed.nameIdFormat).toBe('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
      expect(parsed.sessionIndex).toBe('_session_abc');
    });
  });

  describe('parseLogoutResponseXml', () => {
    it('should parse a LogoutResponse XML', () => {
      const xml = buildLogoutResponse({
        id: '_resp_parse_123',
        issueInstant: '2024-01-15T10:31:00Z',
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/slo',
        inResponseTo: '_req_original_456',
        statusCode: STATUS_CODES.SUCCESS,
        statusMessage: 'Logout successful',
      });

      const parsed = parseLogoutResponseXml(xml);

      expect(parsed.id).toBe('_resp_parse_123');
      expect(parsed.issueInstant).toBe('2024-01-15T10:31:00Z');
      expect(parsed.issuer).toBe('https://idp.example.com');
      expect(parsed.destination).toBe('https://sp.example.com/slo');
      expect(parsed.inResponseTo).toBe('_req_original_456');
      expect(parsed.statusCode).toBe(STATUS_CODES.SUCCESS);
      expect(parsed.statusMessage).toBe('Logout successful');
    });
  });

  describe('encodeForPostBinding', () => {
    it('should base64 encode XML for POST binding', () => {
      const xml = '<test>Hello</test>';
      const encoded = encodeForPostBinding(xml);

      // Decode and verify
      const decoded = atob(encoded);
      expect(decoded).toBe(xml);
    });
  });
});
