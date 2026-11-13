<script lang="ts">
	import { ApiError } from '#lib/api/api-error.js';
	import { createFakeAuthenticationMethodProfiles } from '#lib/api/fake/authentication-method-profiles-fake.js';
	import { createFakeClients } from '#lib/api/fake/clients-fake.js';
	import {
		createFakeConsentStatements,
		MOCK_CONSENT_STATEMENTS
	} from '#lib/api/fake/consent-statements-fake.js';
	import { createFakeSamlProviders } from '#lib/api/fake/saml-providers-fake.js';
	import { createFakeSchemaSetting } from '#lib/api/fake/schema-setting-fake.js';
	import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
	import { createFakeSessionProfiles } from '#lib/api/fake/session-profiles-fake.js';
	import { MOCK_SCREENS } from '#lib/mock/fixtures/screens.js';
	import { loadSchemas } from '#lib/pages/customization/screens/schema-choices.svelte.js';
	import { provideFlowResources } from './flow-resources-context';
	import StepConditionsField from './StepConditionsField.svelte';
	import { hasIncompleteRule, whenOf } from './step-condition-model';

	/** Storybook only: a step's "shown to", with the tenant's attributes, screens and apps. */
	interface Props {
		/** The rules the step already has (as the field keeps them). */
		initial?: string[];
		/** The flow's screens before the step (their answers can be compared). */
		answerScreens?: string[];
		/** The attribute schema cannot be read. */
		attributesFail?: boolean;
		/** The screens cannot be read. */
		screensFail?: boolean;
	}

	let {
		initial = [],
		answerScreens = [],
		attributesFail = false,
		screensFail = false
	}: Props = $props();

	const fakeScreens = createFakeScreens({ screens: MOCK_SCREENS });

	const schema = createFakeSchemaSetting();
	provideFlowResources({
		methodProfiles: createFakeAuthenticationMethodProfiles(),
		sessionProfiles: createFakeSessionProfiles(),
		screens: {
			...fakeScreens,
			list: () =>
				screensFail
					? Promise.reject(new ApiError(500, 'server_error', 'Failed'))
					: fakeScreens.list()
		},
		clients: createFakeClients(),
		samlProviders: createFakeSamlProviders(),
		consentStatements: createFakeConsentStatements(MOCK_CONSENT_STATEMENTS),
		canCreateProfile: () => false,
		userAttributes: (signal) =>
			attributesFail
				? Promise.reject(new ApiError(500, 'server_error', 'Failed'))
				: loadSchemas(schema, 'story', signal)
	});
	let value = $derived([...initial]);
</script>

<div style="max-width:760px">
	<StepConditionsField
		label="Shown to"
		hint="With no condition, everyone sees this step."
		{value}
		onchange={(next) => (value = next)}
		{answerScreens}
	/>
	<pre data-testid="when">{JSON.stringify(whenOf(value))}</pre>
	<p data-testid="incomplete">{hasIncompleteRule(value) ? 'incomplete' : 'complete'}</p>
</div>
