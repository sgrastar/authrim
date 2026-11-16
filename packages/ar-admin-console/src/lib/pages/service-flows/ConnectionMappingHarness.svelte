<script lang="ts">
	import { untrack } from 'svelte';
	import Page from '#lib/ui/templates/Page.svelte';
	import { provideIdentifierMaterials } from '#lib/ui/patterns/identifier-materials-context.js';
	import { createFakeIdentifierMaterials } from '#lib/api/fake/identifier-materials-fake.js';
	import { emptyAnswers } from './connection-model';
	import { connectionMappingFixture, type MappingScenario } from './connection-mapping.fixture';
	import ServiceFlowDetail from './ServiceFlowDetail.svelte';

	let {
		scenario = 'shared',
		protocol = 'oidc',
		events = []
	}: { scenario?: MappingScenario; protocol?: 'oidc' | 'saml'; events?: string[] } = $props();
	provideIdentifierMaterials(createFakeIdentifierMaterials());
	const fixture = untrack(() => connectionMappingFixture(scenario, protocol));
	const binding = fixture.resources.bind;
	fixture.resources.bind = async (set, key) => {
		await binding(set, key);
		events.push('bound');
	};
	let answers = $state(
		untrack(() => {
			const value = emptyAnswers();
			value.kind = protocol === 'oidc' ? 'rp' : 'sp';
			value.direction = 'out';
			value.rp.name = 'Staff portal';
			value.rp.redirectUris = ['https://portal.example.test/callback'];
			value.sp.entityId = 'https://portal.example.test/saml';
			value.active = true;
			return value;
		})
	);
</script>

<Page withFlow
	><ServiceFlowDetail
		bind:answers
		mappingResources={fixture.resources}
		onback={() => events.push('back')}
	/></Page
>
