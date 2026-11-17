<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { ClientSettingsClient } from '#lib/api/clients.js';
	import type { SamlSettingsClient, SamlActivationClient } from '#lib/api/saml-providers.js';
	import Page from '#lib/ui/templates/Page.svelte';
	import { provideIdentifierMaterials } from '#lib/ui/patterns/identifier-materials-context.js';
	import { createFakeIdentifierMaterials } from '#lib/api/fake/identifier-materials-fake.js';
	import {
		basicSettingsAnswers,
		type ConnectionSettingsResources
	} from './connection-basic-settings';
	import { emptyAnswers } from './connection-model';
	import { connectionMappingFixture } from './connection-mapping.fixture';
	import ServiceFlowDetail from './ServiceFlowDetail.svelte';

	let {
		kind = 'rp',
		clients,
		saml,
		canEdit = true,
		mappingMissing = false,
		onbind,
		onback
	}: {
		kind?: 'rp' | 'sp';
		clients: ClientSettingsClient;
		saml: SamlSettingsClient & SamlActivationClient;
		canEdit?: boolean;
		mappingMissing?: boolean;
		onbind?: () => void;
		onback?: () => void;
	} = $props();
	provideIdentifierMaterials(createFakeIdentifierMaterials());
	const fixture = untrack(() =>
		connectionMappingFixture('shared', kind === 'rp' ? 'oidc' : 'saml')
	);
	const bind = fixture.resources.bind;
	fixture.resources.bind = async (set, key) => {
		await bind(set, key);
		onbind?.();
		if (kind === 'sp')
			settings = { kind, detail: await saml.getServiceProvider('portal'), client: saml };
	};
	if (untrack(() => mappingMissing))
		fixture.resources.readBinding = async () => ({ setId: '', pinned: false });
	let settings = $state<ConnectionSettingsResources | null>(null);
	let answers = $state(emptyAnswers());
	onMount(() => {
		void (async () => {
			const loaded: ConnectionSettingsResources =
				kind === 'rp'
					? { kind, detail: await clients.get('portal'), client: clients }
					: { kind, detail: await saml.getServiceProvider('portal'), client: saml };
			settings = loaded;
			answers = basicSettingsAnswers(loaded);
		})();
	});
</script>

<Page withFlow>
	{#if settings}<ServiceFlowDetail
			bind:answers
			settingsResources={settings}
			mappingResources={fixture.resources}
			{canEdit}
			canEditMapping={canEdit}
			{onback}
		/>{/if}
</Page>
