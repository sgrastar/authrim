<script lang="ts">
	import { goto } from '$app/navigation';
	import AddConnection from './AddConnection.svelte';
	import {
		connectionPath,
		createConnection,
		type ConnectionCreationResources
	} from './connection-creation';
	import type { ConnectionKind } from './connection-model';
	const kinds: ConnectionKind[] = ['rp', 'sp', 'op', 'idp'];
	let {
		resources,
		dirty = $bindable(false),
		oncancel,
		ondone,
		onnavigate = goto
	}: {
		resources: ConnectionCreationResources;
		dirty?: boolean;
		oncancel?: () => void;
		ondone?: () => void;
		onnavigate?: (path: string) => void | Promise<void>;
	} = $props();
</script>

<AddConnection
	bind:dirty
	{oncancel}
	{ondone}
	live={{
		kinds: kinds.filter(
			(kind) =>
				resources.canCreate(kind) &&
				(kind !== 'op' || !!resources.externalProviders) &&
				(kind !== 'idp' || !!resources.samlIdentityProviders)
		),
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
