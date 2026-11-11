<script lang="ts">
	import type { FlowRecord, FlowsClient } from '#lib/api/flows.js';
	import { createFakeAuthenticationMethodProfiles } from '#lib/api/fake/authentication-method-profiles-fake.js';
	import { createFakeClients } from '#lib/api/fake/clients-fake.js';
	import { createFakeSamlProviders } from '#lib/api/fake/saml-providers-fake.js';
	import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
	import { createFakeSessionProfiles } from '#lib/api/fake/session-profiles-fake.js';
	import { MOCK_SCREENS } from '#lib/mock/fixtures/screens.js';
	import AccountServiceFlowsPage from './AccountServiceFlowsPage.svelte';
	import { provideFlowResources } from './flow-resources-context';
	import { SEEDED_LOGIN_EDITOR } from './seeded-login-flow.fixture';

	/**
	 * The account service flows with the tenant's Flows behind them (Storybook): the standard
	 * sign-in every tenant is given, or a read that fails. What is saved is kept in `saves`.
	 *
	 * `race`: the first read of the sign-up fails while that of the sign-in is held (an older
	 * sign-in, answered only when `control.release()` is called); a retry reads the current one.
	 */
	interface Props {
		answer: 'seeded' | 'failed' | 'race';
		saves?: { kind: string; editor: unknown }[];
		control?: { release?: () => void };
	}

	let { answer, saves = [], control = {} }: Props = $props();
	let reads = 0;

	const seededLogin: FlowRecord = {
		id: 'flow-default-login-no-consent',
		displayName: 'Authentication-only Login',
		kind: 'login',
		status: 'published',
		editor: structuredClone(SEEDED_LOGIN_EDITOR),
		publishedVersionId: 'v1',
		createdAt: 1_790_000_000,
		updatedAt: 1_790_000_000
	};
	const flows: FlowsClient = {
		async tenantFlow(kind) {
			if (answer === 'failed') throw new Error('unavailable');
			if (answer === 'race' && reads++ < 2) {
				if (kind === 'registration') throw new Error('unavailable');
				await new Promise<void>((resolve) => (control.release = resolve));
				return { ...structuredClone(seededLogin), displayName: 'Old sign-in' };
			}
			return kind === 'login' ? structuredClone(seededLogin) : null;
		},
		async create(input) {
			saves.push({ kind: input.kind, editor: input.editor });
			return { ...seededLogin, id: `flow-${input.kind}`, kind: input.kind, editor: input.editor };
		},
		async update(id, input) {
			saves.push({ kind: 'update', editor: input.editor });
			return { ...seededLogin, id, displayName: input.displayName, editor: input.editor };
		},
		async publish() {},
		async assignToTenant() {}
	};
	provideFlowResources({
		methodProfiles: createFakeAuthenticationMethodProfiles(),
		sessionProfiles: createFakeSessionProfiles(),
		screens: createFakeScreens({ screens: MOCK_SCREENS }),
		clients: createFakeClients(),
		samlProviders: createFakeSamlProviders(),
		flows,
		canCreateProfile: () => false
	});
</script>

<AccountServiceFlowsPage />
