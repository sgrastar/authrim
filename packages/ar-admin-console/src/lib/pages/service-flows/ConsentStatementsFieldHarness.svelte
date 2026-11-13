<script lang="ts">
	import { ApiError } from '#lib/api/api-error.js';
	import type { ConsentStatementsClient } from '#lib/api/consent-statements.js';
	import { createFakeAuthenticationMethodProfiles } from '#lib/api/fake/authentication-method-profiles-fake.js';
	import { createFakeClients } from '#lib/api/fake/clients-fake.js';
	import {
		createFakeConsentStatements,
		MOCK_CONSENT_STATEMENTS
	} from '#lib/api/fake/consent-statements-fake.js';
	import { createFakeSamlProviders } from '#lib/api/fake/saml-providers-fake.js';
	import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
	import { createFakeSessionProfiles } from '#lib/api/fake/session-profiles-fake.js';
	import ConsentStatementsField from './ConsentStatementsField.svelte';
	import { provideFlowResources } from './flow-resources-context';

	/** Storybook only: the consent statements choice as the tenant's statement list answers. */
	interface Props {
		answer: 'some' | 'none' | 'failed';
		/** What the flow already asks (`<id>:required` / `<id>:optional`). */
		initial?: string[];
		unavailable?: boolean;
		/** Whether a statement may be made from the flow (default yes). */
		canCreate?: boolean;
	}

	let { answer, initial = [], unavailable = false, canCreate = true }: Props = $props();

	const real = createFakeConsentStatements(MOCK_CONSENT_STATEMENTS);
	/** Statements made in the story: listed even when the tenant had none. */
	const made: string[] = [];
	const consentStatements: ConsentStatementsClient = {
		...real,
		async list(signal) {
			if (answer === 'failed') throw new ApiError(500, 'server_error', 'Failed');
			const list = await real.list(signal);
			return answer === 'none' ? list.filter((item) => made.includes(item.statement.id)) : list;
		},
		async create(input) {
			const statement = await real.create(input);
			made.push(statement.id);
			return statement;
		}
	};
	provideFlowResources({
		methodProfiles: createFakeAuthenticationMethodProfiles(),
		sessionProfiles: createFakeSessionProfiles(),
		screens: createFakeScreens({ screens: [] }),
		clients: createFakeClients(),
		samlProviders: createFakeSamlProviders(),
		consentStatements,
		canCreateProfile: () => false,
		canCreateStatement: () => canCreate
	});
	let value = $derived([...initial]);
</script>

<ConsentStatementsField
	label="Statements to ask for consent"
	{value}
	onchange={(next) => (value = next)}
	{unavailable}
/>
<output data-testid="value">{value.join(' | ')}</output>
