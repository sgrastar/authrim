import { describe, expect, it } from 'vitest';
import { buildSAMLPolicyFailureAuditMetadata, SAML_POLICY_FAILED_AUDIT_EVENT } from '../audit';

describe('SAML IdP audit helpers', () => {
  it('builds PII-minimized policy failure audit metadata', () => {
    const metadata = JSON.parse(
      buildSAMLPolicyFailureAuditMetadata({
        failureKind: 'required_attribute_missing',
        spEntityId: 'https://sp.example.com/saml',
        authnRequestId: '_request123',
        missingAttributes: [
          {
            name: 'urn:oid:0.9.2342.19200300.100.1.3',
            friendlyName: 'mail',
            source: 'claim',
            claim: 'email',
          },
        ],
      })
    );

    expect(SAML_POLICY_FAILED_AUDIT_EVENT).toBe('saml.policy.failed');
    expect(metadata).toEqual({
      protocol: 'saml',
      failure_kind: 'required_attribute_missing',
      sp_entity_id: 'https://sp.example.com/saml',
      request_id: '_request123',
      missing_attributes: [
        {
          name: 'urn:oid:0.9.2342.19200300.100.1.3',
          friendly_name: 'mail',
          source: 'claim',
          claim: 'email',
        },
      ],
    });
    expect(metadata.userId).toBeUndefined();
    expect(metadata.sessionId).toBeUndefined();
  });

  it('builds AuthnRequest policy failure audit metadata without user identifiers', () => {
    const metadata = JSON.parse(
      buildSAMLPolicyFailureAuditMetadata({
        failureKind: 'authn_request_unsupported_signature_algorithm',
        spEntityId: 'https://sp.example.com/saml',
        authnRequestId: '_request123',
        policyDetails: {
          algorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
        },
      })
    );

    expect(metadata).toEqual({
      protocol: 'saml',
      failure_kind: 'authn_request_unsupported_signature_algorithm',
      sp_entity_id: 'https://sp.example.com/saml',
      request_id: '_request123',
      policy_details: {
        algorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
      },
    });
    expect(metadata.userId).toBeUndefined();
    expect(metadata.sessionId).toBeUndefined();
  });
});
