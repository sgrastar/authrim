import { describe, expect, it } from 'vitest';
import { SAML_MESSAGE_LIMITS, parsePostBindingFormDataWithLimit } from '../message-limits';

describe('SAML POST binding body limits', () => {
  it('parses urlencoded POST binding form data within the body limit', async () => {
    const request = new Request('https://auth.example.test/saml/sp/acs', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SAMLResponse: 'response',
        RelayState: 'state',
      }),
    });

    const formData = await parsePostBindingFormDataWithLimit(request);

    expect(formData.get('SAMLResponse')).toBe('response');
    expect(formData.get('RelayState')).toBe('state');
  });

  it('rejects POST binding requests with an excessive content length', async () => {
    const request = new Request('https://auth.example.test/saml/sp/acs', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(SAML_MESSAGE_LIMITS.postBodyBytes + 1),
      },
      body: 'SAMLResponse=response',
    });

    await expect(parsePostBindingFormDataWithLimit(request)).rejects.toThrow(
      'SAML POST body exceeds maximum size'
    );
  });

  it('rejects unsupported POST binding content types before parsing form data', async () => {
    const request = new Request('https://auth.example.test/saml/sp/acs', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'SAMLResponse=response',
    });

    await expect(parsePostBindingFormDataWithLimit(request)).rejects.toThrow(
      'SAML POST binding requires application/x-www-form-urlencoded'
    );
  });
});
