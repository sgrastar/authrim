/**
 * What a service flow chooses from that lives elsewhere in the console: the tenant's sign-in
 * method profiles, its screens, its clients, its SAML service providers, its consent statements
 * and its attribute schema. The live page hands down the Admin API clients; the mock pages
 * and Storybook, which have none, fall back to in-memory ones, so a profile made there lives only
 * as long as the page.
 */
import { getContext, setContext } from 'svelte';
import type { AuthenticationMethodProfilesClient } from '#lib/api/authentication-method-profiles.js';
import type { ClientsClient } from '#lib/api/clients.js';
import type { ConsentStatementsClient } from '#lib/api/consent-statements.js';
import {
	createFakeConsentStatements,
	MOCK_CONSENT_STATEMENTS
} from '#lib/api/fake/consent-statements-fake.js';
import type { FlowsClient } from '#lib/api/flows.js';
import type { SamlProvidersClient } from '#lib/api/saml-providers.js';
import { createFakeAuthenticationMethodProfiles } from '#lib/api/fake/authentication-method-profiles-fake.js';
import { createFakeSessionProfiles } from '#lib/api/fake/session-profiles-fake.js';
import type { SessionProfilesClient } from '#lib/api/session-profiles.js';
import { createFakeClients } from '#lib/api/fake/clients-fake.js';
import { createFakeSamlProviders } from '#lib/api/fake/saml-providers-fake.js';
import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
import type { ThemeValues } from '#lib/api/login-ui-themes.js';
import type { ScreensClient } from '#lib/api/screens.js';
import type { Schema } from '#lib/api/schema-setting.js';
import { createFakeSchemaSetting } from '#lib/api/fake/schema-setting-fake.js';
import { loadSchemas } from '#lib/pages/customization/screens/schema-choices.svelte.js';
import { MOCK_SCREENS } from '#lib/mock/fixtures/screens.js';

const FLOW_RESOURCES = Symbol('flow-resources');

export interface FlowResources {
	methodProfiles: AuthenticationMethodProfilesClient;
	/** The tenant's session profiles (how long a session the flow makes lasts, single sign-on). */
	sessionProfiles: SessionProfilesClient;
	screens: ScreensClient;
	/** The tenant's clients (where a sign-up can go on to sign in to another service). */
	clients: ClientsClient;
	/** The tenant's SAML service providers (the same, by SAML). */
	samlProviders: SamlProvidersClient;
	/** The tenant's consent statements (what a sign-up or sign-in can ask people to agree to). */
	consentStatements: ConsentStatementsClient;
	/**
	 * Where the sign-up flow is kept (the tenant's Flows). Absent (the mock pages, Storybook): the
	 * flows are kept in the page only.
	 */
	flows?: FlowsClient;
	/** Whether a new sign-in method profile may be made from the flow. */
	canCreateProfile: () => boolean;
	/**
	 * Whether a new consent statement may be made (and published) from the flow. Absent: as for a
	 * profile (both are the tenant's settings).
	 */
	canCreateStatement?: () => boolean;
	/**
	 * The tenant's failed sign-in attempts that lock an account (shown in the sign-in flow); without
	 * it the setting's default is shown.
	 */
	failedSignInLimit?: (signal: AbortSignal) => Promise<number>;
	/** The applied Login UI theme, for the screen preview; without it the default theme is used. */
	loadTheme?: (signal: AbortSignal) => Promise<ThemeValues>;
	/**
	 * The tenant's attribute schema (what a step's "shown to" can compare besides the standard
	 * profile attributes). Without it, only the standard ones are offered.
	 */
	userAttributes?: (signal: AbortSignal) => Promise<Schema[]>;
}

export function provideFlowResources(resources: FlowResources): void {
	setContext(FLOW_RESOURCES, resources);
}

let fallback: FlowResources | undefined;

/** Call during component init. */
export function useFlowResources(): FlowResources {
	const provided = getContext<FlowResources | undefined>(FLOW_RESOURCES);
	if (provided) return provided;
	// One for the whole page, so a profile made in one setting is still there in the next.
	fallback ??= {
		methodProfiles: createFakeAuthenticationMethodProfiles(),
		sessionProfiles: createFakeSessionProfiles(),
		screens: createFakeScreens({ screens: MOCK_SCREENS }),
		clients: createFakeClients(),
		samlProviders: createFakeSamlProviders(),
		consentStatements: createFakeConsentStatements(MOCK_CONSENT_STATEMENTS),
		canCreateProfile: () => true,
		userAttributes: (signal) => loadSchemas(createFakeSchemaSetting(), 'mock', signal)
	};
	return fallback;
}
