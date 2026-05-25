import { generateKeyPairSync } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SignOptions } from '../../common/signature';
import { SAML_NAMESPACES } from '../../common/constants';
import { findDirectChildElement, parseXml } from '../../common/xml-utils';
import { buildSAMLResponse } from '../assertion';
import {
  applySAMLErrorResponseSigningPolicy,
  applySAMLResponseSigningPolicy,
  extractSAMLProtocolMessageId,
  extractSAMLResponseIds,
} from '../signing';

const responseXml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="_response123"
  Version="2.0"
  IssueInstant="2024-01-15T10:30:00Z">
  <saml:Issuer>https://idp.example.com</saml:Issuer>
  <saml:Assertion ID="_assertion456" Version="2.0" IssueInstant="2024-01-15T10:30:00Z">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
    <saml:Subject>
      <saml:NameID>user@example.com</saml:NameID>
    </saml:Subject>
  </saml:Assertion>
</samlp:Response>`;

const signingMaterial = {
  privateKeyPem: 'private-key',
  certificate: 'certificate',
};

function createRealSigningMaterial() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
  };
}

function validResponseXml(): string {
  return buildSAMLResponse({
    responseId: '_response123',
    assertionId: '_assertion456',
    issueInstant: '2024-01-15T10:30:00Z',
    issuer: 'https://idp.example.com',
    destination: 'https://sp.example.com/acs',
    inResponseTo: '_request789',
    recipientUrl: 'https://sp.example.com/acs',
    audienceRestriction: 'https://sp.example.com',
    nameId: 'user@example.com',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    authnInstant: '2024-01-15T10:30:00Z',
    sessionIndex: '_session123',
    notBefore: '2024-01-15T10:29:00Z',
    notOnOrAfter: '2024-01-15T10:35:00Z',
    authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
  });
}

function elementChildNames(element: Element): string[] {
  const names: string[] = [];
  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    if (child?.nodeType === 1) {
      names.push((child as Element).localName);
    }
  }
  return names;
}

describe('SAML response signing policy', () => {
  it('extracts Response and Assertion IDs using XML parsing', () => {
    expect(extractSAMLResponseIds(responseXml)).toEqual({
      responseId: '_response123',
      assertionId: '_assertion456',
    });
  });

  it('rejects a nested Response when extracting IDs for signing', () => {
    const wrappedResponse = `<wrapper>${responseXml}</wrapper>`;

    expect(() => extractSAMLResponseIds(wrappedResponse)).toThrow(
      'Cannot sign SAML Response: missing Response element'
    );
  });

  it('signs only the Assertion when signAssertions is true', () => {
    const signer = vi.fn((xml: string, options: SignOptions) => {
      return `${xml}\n<!-- signed ${options.referenceUri} -->`;
    });

    const signed = applySAMLResponseSigningPolicy(
      responseXml,
      { signAssertions: true, signResponses: false },
      signingMaterial,
      signer
    );

    expect(signer).toHaveBeenCalledTimes(1);
    expect(signer.mock.calls[0]?.[1].referenceUri).toBe('#_assertion456');
    expect(signer.mock.calls[0]?.[1].signatureLocation).toBe('after');
    expect(signer.mock.calls[0]?.[1].signatureInsertionXPath).toContain("local-name()='Issuer'");
    expect(signed).toContain('signed #_assertion456');
  });

  it('signs only the Response when signResponses is true', () => {
    const signer = vi.fn((xml: string, options: SignOptions) => {
      return `${xml}\n<!-- signed ${options.referenceUri} -->`;
    });

    const signed = applySAMLResponseSigningPolicy(
      responseXml,
      { signAssertions: false, signResponses: true },
      signingMaterial,
      signer
    );

    expect(signer).toHaveBeenCalledTimes(1);
    expect(signer.mock.calls[0]?.[1].referenceUri).toBe('#_response123');
    expect(signer.mock.calls[0]?.[1].signatureLocation).toBe('after');
    expect(signer.mock.calls[0]?.[1].signatureInsertionXPath).toContain("local-name()='Issuer'");
    expect(signed).toContain('signed #_response123');
  });

  it('signs Assertion first and then Response when both are required', () => {
    const signer = vi.fn((xml: string, options: SignOptions) => {
      return `${xml}\n<!-- signed ${options.referenceUri} -->`;
    });

    applySAMLResponseSigningPolicy(
      responseXml,
      { signAssertions: true, signResponses: true },
      signingMaterial,
      signer
    );

    expect(signer).toHaveBeenCalledTimes(2);
    expect(signer.mock.calls[0]?.[1].referenceUri).toBe('#_assertion456');
    expect(signer.mock.calls[1]?.[1].referenceUri).toBe('#_response123');
  });

  it('places Assertion signatures after Issuer to satisfy SAML schema ordering', () => {
    const signed = applySAMLResponseSigningPolicy(
      validResponseXml(),
      { signAssertions: true, signResponses: false },
      createRealSigningMaterial()
    );
    const doc = parseXml(signed);
    const assertion = findDirectChildElement(
      doc.documentElement,
      SAML_NAMESPACES.SAML2,
      'Assertion'
    );

    expect(elementChildNames(assertion!)).toEqual(
      expect.arrayContaining(['Issuer', 'Signature', 'Subject'])
    );
    expect(elementChildNames(assertion!).slice(0, 3)).toEqual(['Issuer', 'Signature', 'Subject']);
  });

  it('places Response signatures after Issuer to satisfy SAML schema ordering', () => {
    const signed = applySAMLResponseSigningPolicy(
      validResponseXml(),
      { signAssertions: false, signResponses: true },
      createRealSigningMaterial()
    );
    const doc = parseXml(signed);

    expect(elementChildNames(doc.documentElement).slice(0, 3)).toEqual([
      'Issuer',
      'Signature',
      'Status',
    ]);
  });

  it('returns unchanged XML when no signatures are required', () => {
    const signer = vi.fn((xml: string) => xml);

    const signed = applySAMLResponseSigningPolicy(
      responseXml,
      { signAssertions: false, signResponses: false },
      signingMaterial,
      signer
    );

    expect(signed).toBe(responseXml);
    expect(signer).not.toHaveBeenCalled();
  });

  it('signs error responses at Response level when only assertion signing is configured', () => {
    const errorResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  ID="_response123"
  Version="2.0"
  IssueInstant="2024-01-15T10:30:00Z">
  <samlp:Status>
    <samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder"/>
  </samlp:Status>
</samlp:Response>`;
    const signer = vi.fn((xml: string, options: SignOptions) => {
      return `${xml}\n<!-- signed ${options.referenceUri} -->`;
    });

    const signed = applySAMLErrorResponseSigningPolicy(
      errorResponseXml,
      { signAssertions: true, signResponses: false },
      signingMaterial,
      signer
    );

    expect(signer).toHaveBeenCalledTimes(1);
    expect(signer.mock.calls[0]?.[1].referenceUri).toBe('#_response123');
    expect(signed).toContain('signed #_response123');
  });

  it('extracts LogoutRequest IDs using XML parsing', () => {
    const logoutRequestXml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  ID="_logout123"
  Version="2.0"
  IssueInstant="2024-01-15T10:30:00Z" />`;

    expect(extractSAMLProtocolMessageId(logoutRequestXml, 'LogoutRequest')).toBe('_logout123');
  });

  it('rejects a nested protocol message when extracting IDs for signing', () => {
    const logoutRequestXml = `<wrapper>
  <samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    ID="_logout123"
    Version="2.0"
    IssueInstant="2024-01-15T10:30:00Z" />
</wrapper>`;

    expect(() => extractSAMLProtocolMessageId(logoutRequestXml, 'LogoutRequest')).toThrow(
      'Cannot sign SAML LogoutRequest: missing LogoutRequest element'
    );
  });
});
