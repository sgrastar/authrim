import { generateAuthenticationOptions, generateRegistrationOptions } from '@simplewebauthn/server';
import { describe, expect, it } from 'vitest';

describe('@simplewebauthn/server v14 compatibility', () => {
  it('generates registration options with the Authrim runtime inputs', async () => {
    const options = await generateRegistrationOptions({
      rpName: 'Authrim',
      rpID: 'login.example.com',
      userName: 'user@example.com',
      userID: new Uint8Array([117, 115, 101, 114, 45, 49]),
      challenge: 'registration-challenge',
      excludeCredentials: [
        {
          id: 'Y3JlZGVudGlhbC0x',
          transports: ['internal', 'hybrid'],
        },
      ],
    });

    expect(options).toMatchObject({
      challenge: 'cmVnaXN0cmF0aW9uLWNoYWxsZW5nZQ',
      rp: { id: 'login.example.com', name: 'Authrim' },
      user: { id: 'dXNlci0x', name: 'user@example.com' },
      excludeCredentials: [
        {
          id: 'Y3JlZGVudGlhbC0x',
          transports: ['internal', 'hybrid'],
        },
      ],
    });
    expect(options.pubKeyCredParams).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'public-key', alg: -7 })])
    );
  });

  it('preserves supported transports in authentication options', async () => {
    const options = await generateAuthenticationOptions({
      rpID: 'login.example.com',
      challenge: 'authentication-challenge',
      allowCredentials: [
        {
          id: 'Y3JlZGVudGlhbC0x',
          transports: ['ble', 'hybrid', 'internal', 'nfc', 'usb'],
        },
      ],
    });

    expect(options).toMatchObject({
      challenge: 'YXV0aGVudGljYXRpb24tY2hhbGxlbmdl',
      rpId: 'login.example.com',
      allowCredentials: [
        {
          id: 'Y3JlZGVudGlhbC0x',
          transports: ['ble', 'hybrid', 'internal', 'nfc', 'usb'],
        },
      ],
    });
  });
});
