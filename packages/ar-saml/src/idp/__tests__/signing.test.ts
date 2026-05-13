import { describe, expect, it, vi } from 'vitest';
import type { SignOptions } from '../../common/signature';
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
  <saml:Assertion ID="_assertion456" Version="2.0" IssueInstant="2024-01-15T10:30:00Z">
    <saml:Subject>
      <saml:NameID>user@example.com</saml:NameID>
    </saml:Subject>
  </saml:Assertion>
</samlp:Response>`;

const signingMaterial = {
  privateKeyPem: 'private-key',
  certificate: 'certificate',
};

describe('SAML response signing policy', () => {
  it('extracts Response and Assertion IDs using XML parsing', () => {
    expect(extractSAMLResponseIds(responseXml)).toEqual({
      responseId: '_response123',
      assertionId: '_assertion456',
    });
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
});
