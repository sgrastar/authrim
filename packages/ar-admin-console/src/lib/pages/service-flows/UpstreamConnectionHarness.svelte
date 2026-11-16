<script lang="ts">
	import { untrack } from 'svelte';
	import AccountServiceFlowsPage from './AccountServiceFlowsPage.svelte';
	import { provideFlowResources, useFlowResources } from './flow-resources-context';
	import LiveAddConnection from './LiveAddConnection.svelte';
	import UpstreamConnectionPage from './UpstreamConnectionPage.svelte';
	import type { ConnectionCreationResources } from './connection-creation';
	import type { ExternalProvidersClient } from '#lib/api/external-providers.js';
	import type { SamlIdentityProvidersClient } from '#lib/api/saml-providers.js';
	/** Story-only navigation target: the same real read/edit component the route renders. */
	let {
		resources,
		initial,
		list = false,
		canEdit = true,
		onnavigate
	}: {
		resources: ConnectionCreationResources & {
			externalProviders: ExternalProvidersClient;
			samlIdentityProviders: SamlIdentityProvidersClient;
		};
		initial?: { kind: 'op' | 'idp'; id: string };
		list?: boolean;
		canEdit?: boolean;
		onnavigate?: (path: string) => void;
	} = $props();
	provideFlowResources({ ...useFlowResources(), connectionCreation: untrack(() => resources) });
	let opened = $state(untrack(() => initial));
</script>

{#if list}
	<AccountServiceFlowsPage showConnections />
{:else if opened}
	<UpstreamConnectionPage
		kind={opened.kind}
		id={opened.id}
		externalProviders={resources.externalProviders}
		samlProviders={resources.samlIdentityProviders}
		canRead
		{canEdit}
		onback={() => (opened = undefined)}
	/>
{:else}
	<LiveAddConnection
		{resources}
		onnavigate={(path) => {
			onnavigate?.(path);
			const match = /\/applications\/all\/(op|idp)\/([^/]+)$/.exec(path);
			const kind = match?.[1];
			if (match && (kind === 'op' || kind === 'idp'))
				opened = { kind, id: decodeURIComponent(match[2]) };
		}}
	/>
{/if}
