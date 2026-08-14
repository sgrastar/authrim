import { describe, expect, it } from 'vitest';
import { STATUS_CODES } from '../../common/constants';
import { findElement, getAttribute, parseXml } from '../../common/xml-utils';
import {
  applySAMLErrorResponseOverride,
  buildSAMLIdPErrorResponse,
  getSAMLAttributeReleaseFailureStatusMessage,
  SAML_ATTRIBUTE_RELEASE_FAILURE_STATUS_MESSAGE,
} from '../error-response';

describe('SAML IdP error response', () => {
  it('builds a SAML protocol error response for required attribute release failure', () => {
    const xml = buildSAMLIdPErrorResponse({
      issuer: 'https://idp.example.com/saml/idp',
      destination: 'https://sp.example.com/acs',
      inResponseTo: '_request123',
      statusCode: STATUS_CODES.RESPONDER,
      secondLevelStatusCode: STATUS_CODES.INVALID_ATTR_NAME_OR_VALUE,
      statusMessage: SAML_ATTRIBUTE_RELEASE_FAILURE_STATUS_MESSAGE,
    });

    const doc = parseXml(xml);
    const response = findElement(doc, 'urn:oasis:names:tc:SAML:2.0:protocol', 'Response');
    const statusCodes = response!.getElementsByTagNameNS(
      'urn:oasis:names:tc:SAML:2.0:protocol',
      'StatusCode'
    );

    expect(getAttribute(response!, 'Destination')).toBe('https://sp.example.com/acs');
    expect(getAttribute(response!, 'InResponseTo')).toBe('_request123');
    expect(getAttribute(statusCodes[0], 'Value')).toBe(STATUS_CODES.RESPONDER);
    expect(getAttribute(statusCodes[1], 'Value')).toBe(STATUS_CODES.INVALID_ATTR_NAME_OR_VALUE);
    expect(xml).toContain(SAML_ATTRIBUTE_RELEASE_FAILURE_STATUS_MESSAGE);
    expect(findElement(doc, 'urn:oasis:names:tc:SAML:2.0:assertion', 'Assertion')).toBeNull();
  });

  it('does not emit an unsigned error response for a configured SP', () => {
    expect(() =>
      buildSAMLIdPErrorResponse({
        issuer: 'https://idp.example.com/saml/idp',
        destination: 'https://sp.example.com/acs',
        spConfig: { signAssertions: false, signResponses: false },
      })
    ).toThrow('SAML Response signing is required');
  });

  it('uses generic required attribute failure messages by default', () => {
    expect(
      getSAMLAttributeReleaseFailureStatusMessage({}, [
        {
          name: 'urn:oid:0.9.2342.19200300.100.1.3',
          friendlyName: 'mail',
          source: 'claim',
          claim: 'email',
        },
      ])
    ).toBe(SAML_ATTRIBUTE_RELEASE_FAILURE_STATUS_MESSAGE);
  });

  it('can include missing attribute labels for detailed user-facing errors', () => {
    expect(
      getSAMLAttributeReleaseFailureStatusMessage(
        { attributeReleaseFailureUserMessageMode: 'detailed' },
        [
          {
            name: 'urn:oid:0.9.2342.19200300.100.1.3',
            friendlyName: 'mail',
            source: 'claim',
            claim: 'email',
          },
          {
            name: 'urn:oid:2.16.840.1.113730.3.1.241',
            friendlyName: 'displayName',
            source: 'claim',
            claim: 'name',
          },
        ]
      )
    ).toBe('Required SAML attributes could not be released: mail, displayName');
  });

  it('applies per-SP error response overrides by failure kind', () => {
    expect(
      applySAMLErrorResponseOverride(
        {
          errorResponseOverrides: [
            {
              failureKind: 'required_attribute_missing',
              statusCode: STATUS_CODES.REQUESTER,
              secondLevelStatusCode: null,
              statusMessage: 'Publisher-specific attribute policy failed',
            },
          ],
        },
        {
          failureKind: 'required_attribute_missing',
          statusCode: STATUS_CODES.RESPONDER,
          secondLevelStatusCode: STATUS_CODES.INVALID_ATTR_NAME_OR_VALUE,
          statusMessage: SAML_ATTRIBUTE_RELEASE_FAILURE_STATUS_MESSAGE,
        }
      )
    ).toEqual({
      failureKind: 'required_attribute_missing',
      statusCode: STATUS_CODES.REQUESTER,
      secondLevelStatusCode: undefined,
      statusMessage: 'Publisher-specific attribute policy failed',
    });
  });
});
