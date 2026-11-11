/**
 * What a service flow chooses from that lives elsewhere in the console: the tenant's sign-in
 * method profiles, its screens, its clients and its SAML service providers. The live page hands down the Admin API clients; the mock pages
 * and Storybook, which have none, fall back to in-memory ones, so a profile made there lives only
 * as long as the page.
 */
import { getContext, setContext } from 'svelte';
import type { AuthenticationMethodProfilesClient } from '#lib/api/authentication-method-profiles.js';
import type { ClientsClient } from '#lib/api/clients.js';
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
	/**
	 * Where the sign-up flow is kept (the tenant's Flows). Absent (the mock pages, Storybook): the
	 * flows are kept in the page only.
	 */
	flows?: FlowsClient;
	/** Whether a new sign-in method profile may be made from the flow. */
	canCreateProfile: () => boolean;
	/** The applied Login UI theme, for the screen preview; without it the default theme is used. */
	loadTheme?: (signal: AbortSignal) => Promise<ThemeValues>;
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
		canCreateProfile: () => true
	};
	return fallback;
}
