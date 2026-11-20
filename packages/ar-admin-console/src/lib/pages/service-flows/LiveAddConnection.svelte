<script lang="ts">
	import { goto } from '$app/navigation';
	import AddConnection from './AddConnection.svelte';
	import {
		connectionPath,
		createConnection,
		type ConnectionCreationResources
	} from './connection-creation';
	import type { ConnectionKind } from './connection-model';
	const kinds: ConnectionKind[] = ['rp', 'sp', 'op', 'idp', 'federation'];
	let {
		resources,
		dirty = $bindable(false),
		oncancel,
		ondone,
		prefillMetadataUrl,
		onnavigate = goto
	}: {
		resources: ConnectionCreationResources;
		dirty?: boolean;
		oncancel?: () => void;
		ondone?: () => void;
		prefillMetadataUrl?: string;
		onnavigate?: (path: string) => void | Promise<void>;
	} = $props();
</script>

<AddConnection
	bind:dirty
	{oncancel}
	{ondone}
	{prefillMetadataUrl}
	live={{
		kinds: kinds.filter(
			(kind) =>
				resources.canCreate(kind) &&
				(kind !== 'op' || !!resources.externalProviders) &&
				(kind !== 'idp' || !!resources.samlIdentityProviders) &&
				(kind !== 'federation' ||
					(!!resources.federationSources && !!resources.federationMappingSets))
		),
		federation:
			resources.federationSources && resources.federationMappingSets
				? { client: resources.federationSources, mappingSets: resources.federationMappingSets }
				: undefined,
		discover: resources.externalProviders
			? (issuer, signal) =>
					resources.externalProviders
						? resources.externalProviders.discover(issuer, signal)
						: Promise.reject(new Error('Discovery unavailable'))
			: undefined,
		previewMetadata: resources.previewMetadata,
		create: (answers, name) => createConnection(resources, answers, name),
		navigate: (connection) => onnavigate(connectionPath(connection))
	}}
/>
