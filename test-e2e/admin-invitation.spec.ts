import { expect, test } from '@playwright/test';

const ADMIN_UI_ORIGIN = 'http://localhost:4175';

function base64Url(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64url');
}

test('enrolls an invited Admin and verifies the newly created Passkey', async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const registrationChallenge = base64Url(Array.from({ length: 32 }, (_, index) => index + 1));
  const authenticationChallenge = base64Url(Array.from({ length: 32 }, (_, index) => index + 33));
  let registeredCredentialId = '';
  let authenticatedCredentialId = '';
  const pageErrors: string[] = [];
  const invitationRequests: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/api/admin/invitations/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    invitationRequests.push(pathname);
    const requestBody = request.postDataJSON() as Record<string, unknown>;

    if (pathname.endsWith('/redeem')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enrollment_token: 'enrollment-token',
          expires_in: 600,
          invitation: {
            email: 'new-admin@example.com',
            name: 'New Admin',
            role: 'Administrator',
            ip_restriction_enabled: true,
          },
        }),
      });
      return;
    }

    if (pathname.endsWith('/passkey/options')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          challenge_id: 'registration-challenge-id',
          options: {
            challenge: registrationChallenge,
            rp: { id: 'localhost', name: 'Authrim Admin' },
            user: {
              id: base64Url([1, 2, 3, 4]),
              name: 'new-admin@example.com',
              displayName: 'New Admin',
            },
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 },
            ],
            timeout: 60_000,
            attestation: 'none',
            authenticatorSelection: {
              residentKey: 'required',
              requireResidentKey: true,
              userVerification: 'required',
            },
            excludeCredentials: [],
          },
        }),
      });
      return;
    }

    if (pathname.endsWith('/passkey/register')) {
      const passkeyResponse = requestBody.passkey_response as { id: string };
      registeredCredentialId = passkeyResponse.id;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          challenge_id: 'authentication-challenge-id',
          options: {
            challenge: authenticationChallenge,
            rpId: 'localhost',
            timeout: 60_000,
            userVerification: 'required',
            allowCredentials: [
              { id: registeredCredentialId, type: 'public-key', transports: ['internal'] },
            ],
          },
        }),
      });
      return;
    }

    if (pathname.endsWith('/activate')) {
      const credential = requestBody.credential as { id: string };
      authenticatedCredentialId = credential.id;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          user: {
            id: 'admin-new',
            email: 'new-admin@example.com',
            name: 'New Admin',
            role: 'Administrator',
          },
        }),
      });
      return;
    }

    await route.abort();
  });

  try {
    await page.goto(`${ADMIN_UI_ORIGIN}/admin/join`, { waitUntil: 'networkidle' });
    await page.locator('#join-email').fill('new-admin@example.com');
    await page.locator('#join-code').fill('2345-6789-ABCD-EFGH');
    await page.locator('form button[type="submit"]').click();

    await expect
      .poll(() => ({ pageErrors, invitationRequests }))
      .toEqual({ pageErrors: [], invitationRequests: ['/api/admin/invitations/redeem'] });
    await expect(page.getByText('new-admin@example.com')).toBeVisible();
    await page.locator('button.primary-button').click();

    await expect
      .poll(() => ({ pageErrors, invitationRequests }))
      .toEqual({
        pageErrors: [],
        invitationRequests: [
          '/api/admin/invitations/redeem',
          '/api/admin/invitations/passkey/options',
          '/api/admin/invitations/passkey/register',
          '/api/admin/invitations/activate',
        ],
      });
    await expect(page.locator('.message.success')).toBeVisible();
    expect(registeredCredentialId).not.toBe('');
    expect(authenticatedCredentialId).toBe(registeredCredentialId);
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    await cdp.send('WebAuthn.disable');
  }
});
