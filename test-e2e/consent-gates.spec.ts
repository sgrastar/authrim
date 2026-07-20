import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

type ConsentItem = {
  statement_id: string;
  slug: string;
  category: string;
  title: string;
  description: string;
  document_url: null;
  inline_content: string;
  version: string;
  version_id: string;
  is_required: boolean;
  checkbox_mode: 'required' | 'optional';
  checkbox_default_checked: boolean;
  display_order: number;
  acceptance_status: 'accepted' | 'pending';
  action_required: boolean;
  accepted_at: number | null;
  accepted_record_id: string | null;
  release_kind?: 'scope' | 'claim' | 'attribute';
  release_name?: string;
  release_locked?: boolean;
  attribute_value_display?: 'names' | 'masked_values' | 'full_values';
  attribute_display_values?: string[];
};

type GateKind = 'legal_document' | 'oidc_authorization' | 'saml_attribute_release';

const authenticationMethods = {
  methods: {
    passkey: { enabled: false, capabilities: [] },
    emailCode: { enabled: false, digits: 6, steps: [] },
    totp: {
      enabled: false,
      preset: 'compatible',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 1,
      defaultAcr: '',
      requirement: { mode: 'optional' },
      steps: [],
    },
    directoryPassword: { enabled: false, label: 'Organization ID', steps: [] },
    humanVerification: {
      enabled: false,
      provider: 'turnstile',
      siteKey: null,
      loginEnabled: false,
      signupEnabled: false,
      reauthEnabled: false,
      failurePolicy: 'fail_closed',
      widget: { actionPrefix: 'authrim', theme: 'auto', size: 'flexible', mode: 'managed' },
    },
    external: { enabled: false, providers: [] },
  },
  ui: {
    theme: 'light',
    variant: 'default',
    branding: { logoUrl: null, brandName: 'Authrim' },
    supportedLocales: ['en'],
  },
  meta: { cacheTTL: 1, revision: 'consent-e2e' },
};

function consentStep(id: string, gateKind: GateKind, items: ConsentItem[]) {
  return {
    id,
    source_node_id: `${id}_node`,
    component: 'consent_policy',
    render: true,
    config: {
      screen: {
        fields: [
          {
            field: 'consent',
            label: gateKind === 'legal_document' ? 'Policies' : 'Information sharing',
            required: true,
            block_type: 'consent_widget',
          },
        ],
      },
    },
    content: {
      consent_policy: {
        id: `${gateKind}_policy`,
        display_name: 'Consent policy',
        description: null,
        language: 'en',
        default_language: 'en',
        gate_kind: gateKind,
        policy_id: `${gateKind}_policy`,
        items,
      },
    },
  };
}

function legalItem(
  id: string,
  title: string,
  status: 'accepted' | 'pending',
  version = '1'
): ConsentItem {
  return {
    statement_id: id,
    slug: id,
    category: id === 'terms' ? 'terms_of_service' : 'privacy_policy',
    title,
    description: '',
    document_url: null,
    inline_content: title,
    version,
    version_id: `${id}_v${version}`,
    is_required: true,
    checkbox_mode: 'required',
    checkbox_default_checked: false,
    display_order: id === 'terms' ? 0 : 1,
    acceptance_status: status,
    action_required: status === 'pending',
    accepted_at: status === 'accepted' ? 1_700_000_000 : null,
    accepted_record_id: status === 'accepted' ? `${id}_record` : null,
  };
}

function releaseItem(
  kind: 'scope' | 'claim' | 'attribute',
  name: string,
  title: string,
  required: boolean
): ConsentItem {
  return {
    statement_id: `${kind}:${name}`,
    slug: `${kind}-${name}`,
    category: kind === 'attribute' ? 'attribute_release' : 'scope_claim_release',
    title,
    description: '',
    document_url: null,
    inline_content: title,
    version: 'request',
    version_id: `${kind}:${name}:request`,
    is_required: required,
    checkbox_mode: required ? 'required' : 'optional',
    checkbox_default_checked: true,
    display_order: required ? 0 : 1,
    acceptance_status: 'pending',
    action_required: true,
    accepted_at: null,
    accepted_record_id: null,
    release_kind: kind,
    release_name: name,
    release_locked: required,
  };
}

function startResponse(step: ReturnType<typeof consentStep>) {
  return {
    schema_version: '1',
    interaction: {
      id: 'interaction-consent-e2e',
      state: 'awaiting_input',
      flow_id: 'flow-common-login',
      flow_version_id: 'flow-common-login-v1',
      current_node_id: step.source_node_id,
      current_step_id: step.id,
      expires_at: 2_000_000_000,
    },
    assignment: { target_type: 'tenant', target_id: null, flow_kind: 'login' },
    contract: { flow_kind: 'login', ui: { steps: [step] } },
    contract_hash: 'contract-hash',
    signature: 'contract-signature',
    expires_in: 300,
    resumed: false,
  };
}

async function mockAuthenticationMethods(page: Page) {
  await page.route('**/api/auth/authentication-methods*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(authenticationMethods),
    });
  });
}

async function fulfillSubmit(
  route: Route,
  step: ReturnType<typeof consentStep> | null,
  protocol: 'direct' | 'oidc' | 'saml'
) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schema_version: '1',
      interaction: {
        id: 'interaction-consent-e2e',
        state: step ? 'awaiting_input' : 'completed',
        flow_id: 'flow-common-login',
        flow_version_id: 'flow-common-login-v1',
        current_node_id: step?.source_node_id ?? null,
        current_step_id: step?.id ?? null,
        expires_at: 2_000_000_000,
      },
      step,
      completed: step === null,
      output: step
        ? null
        : {
            action: 'complete',
            protocol_continuation: { protocol, consent_gate_receipt_id: `${protocol}-receipt` },
          },
    }),
  });
}

test.describe('Flow Consent Gates', () => {
  test.describe.configure({ mode: 'serial' });

  test('renders accepted and pending legal documents accessibly and submits pending decisions only', async ({
    page,
  }) => {
    await mockAuthenticationMethods(page);
    const legal = consentStep('legal-step', 'legal_document', [
      legalItem('terms', 'Terms of Service A', 'accepted'),
      legalItem('privacy', 'Privacy Policy B', 'pending'),
    ]);
    let submitBody: Record<string, unknown> | undefined;

    await page.route('**/api/v1/login/interactions/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(startResponse(legal)),
      });
    });
    await page.route('**/api/v1/login/interactions/*/submit', async (route) => {
      submitBody = route.request().postDataJSON() as Record<string, unknown>;
      await fulfillSubmit(route, null, 'direct');
    });

    await page.goto('/login');

    const terms = page.locator('.runtime-consent-item').filter({ hasText: 'Terms of Service A' });
    const privacy = page.locator('.runtime-consent-item').filter({ hasText: 'Privacy Policy B' });
    const continueButton = page.getByRole('button', { name: 'Continue' });
    await expect(terms.getByRole('checkbox')).toBeChecked();
    await expect(terms.getByRole('checkbox')).toBeDisabled();
    await expect(terms.getByRole('status')).toContainText('Accepted');
    await expect(privacy.getByRole('checkbox')).not.toBeChecked();
    await expect(privacy.getByRole('checkbox')).toBeEnabled();
    await expect(continueButton).toBeDisabled();

    await privacy.getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    await expect(privacy.getByRole('checkbox')).toBeChecked();
    await expect(continueButton).toBeEnabled();

    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);

    await continueButton.click();
    await expect.poll(() => submitBody).toBeTruthy();
    expect(submitBody).toMatchObject({
      selected_handle: 'accepted',
      input: {
        consent_item_decisions: { privacy: 'granted' },
        consent_item_selected_values: {},
      },
    });
    expect(JSON.stringify(submitBody)).not.toContain('terms');
  });

  test('advances Legal to OIDC Gate once and preserves the selected scope subset', async ({
    page,
  }) => {
    await mockAuthenticationMethods(page);
    const legal = consentStep('legal-step', 'legal_document', [
      legalItem('terms-v2', 'Terms of Service A v2', 'pending', '2'),
    ]);
    const oidc = consentStep('oidc-step', 'oidc_authorization', [
      releaseItem('scope', 'openid', 'OpenID identifier', true),
      releaseItem('scope', 'profile', 'Profile information', false),
    ]);
    const submitted: Array<Record<string, unknown>> = [];
    let legacyConsentRequests = 0;

    await page.route('**/api/v1/login/interactions/start', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(startResponse(legal)),
      })
    );
    await page.route('**/api/v1/login/interactions/*/submit', async (route) => {
      submitted.push(route.request().postDataJSON() as Record<string, unknown>);
      await fulfillSubmit(route, submitted.length === 1 ? oidc : null, 'oidc');
    });
    await page.route('**/api/consent**', async (route) => {
      legacyConsentRequests += 1;
      await route.abort();
    });

    await page.goto('/login');
    await page.getByRole('checkbox', { name: 'Terms of Service A v2' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();

    const openid = page.getByRole('checkbox', { name: 'OpenID identifier' });
    const profile = page.getByRole('checkbox', { name: 'Profile information' });
    await expect(openid).toBeChecked();
    await expect(openid).toBeDisabled();
    await expect(profile).toBeChecked();
    await profile.uncheck();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect.poll(() => submitted.length).toBe(2);
    expect(submitted[1]).toMatchObject({
      input: {
        consent_item_decisions: {
          'scope:openid': 'granted',
          'scope:profile': 'denied',
        },
      },
    });
    expect(legacyConsentRequests).toBe(0);
  });

  test('locks required SAML attributes while allowing optional attributes to be declined', async ({
    page,
  }) => {
    await mockAuthenticationMethods(page);
    const saml = consentStep('saml-step', 'saml_attribute_release', [
      releaseItem('attribute', 'mail', 'Email address', true),
      releaseItem('attribute', 'displayName', 'Display name', false),
    ]);
    let submitBody: Record<string, unknown> | undefined;

    await page.route('**/api/v1/login/interactions/start', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(startResponse(saml)),
      })
    );
    await page.route('**/api/v1/login/interactions/*/submit', async (route) => {
      submitBody = route.request().postDataJSON() as Record<string, unknown>;
      await fulfillSubmit(route, null, 'saml');
    });

    await page.goto('/login');
    const email = page.getByRole('checkbox', { name: 'Email address' });
    const displayName = page.getByRole('checkbox', { name: 'Display name' });
    await expect(email).toBeChecked();
    await expect(email).toBeDisabled();
    await displayName.uncheck();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect.poll(() => submitBody).toBeTruthy();
    expect(submitBody).toMatchObject({
      input: {
        consent_item_decisions: {
          'attribute:mail': 'granted',
          'attribute:displayName': 'denied',
        },
      },
    });
  });

  test('requires a newly published ToS version for an existing session', async ({ page }) => {
    await mockAuthenticationMethods(page);
    const legal = consentStep('legal-v2-step', 'legal_document', [
      legalItem('terms-v2', 'Terms of Service A v2', 'pending', '2'),
    ]);
    await page.route('**/api/v1/login/interactions/start', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(startResponse(legal)),
      })
    );
    await page.route('**/api/v1/login/interactions/*/submit', (route) =>
      fulfillSubmit(route, null, 'oidc')
    );

    await page.goto('/login');
    await expect(page.getByRole('checkbox', { name: 'Terms of Service A v2' })).not.toBeChecked();
    await page.getByRole('checkbox', { name: 'Terms of Service A v2' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
  });

  test('shows OIDC release confirmation for prompt=consent after Legal Consent is satisfied', async ({
    page,
  }) => {
    await mockAuthenticationMethods(page);
    const oidc = consentStep('prompt-consent-step', 'oidc_authorization', [
      releaseItem('scope', 'openid', 'OpenID identifier', true),
      releaseItem('claim', 'department', 'Department from identity mapping', true),
    ]);
    await page.route('**/api/v1/login/interactions/start', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(startResponse(oidc)),
      })
    );
    await page.route('**/api/v1/login/interactions/*/submit', (route) =>
      fulfillSubmit(route, null, 'oidc')
    );

    await page.goto('/login');
    await expect(page.getByRole('checkbox', { name: 'OpenID identifier' })).toBeDisabled();
    await expect(
      page.getByRole('checkbox', { name: 'Department from identity mapping' })
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Continue' }).click();
  });

  for (const error of ['login_required', 'consent_required'] as const) {
    test(`keeps prompt=none non-interactive when ${error} is required`, async ({ page }) => {
      await mockAuthenticationMethods(page);
      let submitRequests = 0;
      await page.route('**/api/v1/login/interactions/start', (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error,
            error_description:
              error === 'login_required'
                ? 'User authentication is required'
                : 'User consent is required',
            error_code: `AR_FLOW_${error.toUpperCase()}`,
          }),
        })
      );
      await page.route('**/api/v1/login/interactions/*/submit', async (route) => {
        submitRequests += 1;
        await route.abort();
      });

      await page.goto('/login');
      await expect(page.getByText(/User (authentication|consent) is required/)).toBeVisible();
      expect(submitRequests).toBe(0);
    });
  }

  test('advances Legal to SAML attribute release and renders masked values only', async ({
    page,
  }) => {
    await mockAuthenticationMethods(page);
    const legal = consentStep('saml-legal-step', 'legal_document', [
      legalItem('privacy', 'Privacy Policy B', 'pending'),
    ]);
    const mail = releaseItem('attribute', 'mail', 'Email address', true);
    mail.attribute_value_display = 'masked_values';
    mail.attribute_display_values = ['u***@example.test'];
    const saml = consentStep('saml-release-step', 'saml_attribute_release', [mail]);
    let submissions = 0;
    await page.route('**/api/v1/login/interactions/start', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(startResponse(legal)),
      })
    );
    await page.route('**/api/v1/login/interactions/*/submit', async (route) => {
      submissions += 1;
      await fulfillSubmit(route, submissions === 1 ? saml : null, 'saml');
    });

    await page.goto('/login');
    await page.getByRole('checkbox', { name: 'Privacy Policy B' }).check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('u***@example.test')).toBeVisible();
    await expect(page.getByText('user@example.test')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue' }).click();
  });

  test('shows an updated SAML attribute set for an existing session', async ({ page }) => {
    await mockAuthenticationMethods(page);
    const saml = consentStep('saml-changed-step', 'saml_attribute_release', [
      releaseItem('attribute', 'mail', 'Email address', true),
      releaseItem('attribute', 'eduPersonAffiliation', 'Affiliation', false),
    ]);
    await page.route('**/api/v1/login/interactions/start', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(startResponse(saml)),
      })
    );
    await page.route('**/api/v1/login/interactions/*/submit', (route) =>
      fulfillSubmit(route, null, 'saml')
    );

    await page.goto('/login');
    await expect(page.getByRole('checkbox', { name: 'Affiliation' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Affiliation' }).uncheck();
    await page.getByRole('button', { name: 'Continue' }).click();
  });
});
