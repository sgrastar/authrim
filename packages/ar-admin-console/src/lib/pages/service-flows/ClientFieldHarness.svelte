<script lang="ts">
	import { ApiError } from '#lib/api/api-error.js';
	import type { ClientsClient } from '#lib/api/clients.js';
	import { createFakeAuthenticationMethodProfiles } from '#lib/api/fake/authentication-method-profiles-fake.js';
	import { createFakeSessionProfiles } from '#lib/api/fake/session-profiles-fake.js';
	import {
		createFakeConsentStatements,
		MOCK_CONSENT_STATEMENTS
	} from '#lib/api/fake/consent-statements-fake.js';
	import { createFakeClients } from '#lib/api/fake/clients-fake.js';
	import { createFakeSamlProviders } from '#lib/api/fake/saml-providers-fake.js';
	import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
	import ClientField from './ClientField.svelte';
	import { provideFlowResources } from './flow-resources-context';

	/** Storybook only: the service (client) choice as the tenant's client list answers. */
	interface Props {
		answer: 'some' | 'none' | 'denied' | 'failed';
	}

	let { answer }: Props = $props();

	const clients: ClientsClient = {
		async list() {
			if (answer === 'denied') throw new ApiError(403, 'forbidden', 'Forbidden');
			if (answer === 'failed') throw new ApiError(500, 'server_error', 'Failed');
			return answer === 'none' ? [] : createFakeClients().list();
		}
	};
	provideFlowResources({
		methodProfiles: createFakeAuthenticationMethodProfiles(),
		sessionProfiles: createFakeSessionProfiles(),
		screens: createFakeScreens({ screens: [] }),
		clients,
		samlProviders: createFakeSamlProviders(),
		consentStatements: createFakeConsentStatements(MOCK_CONSENT_STATEMENTS),
		canCreateProfile: () => false
	});
	let value = $state('');
</script>

<ClientField
	label="Service to sign in to"
	mode="client"
	{value}
	onchange={(next) => (value = next)}
/>
