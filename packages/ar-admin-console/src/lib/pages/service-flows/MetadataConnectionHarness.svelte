<script lang="ts">
	import { untrack } from 'svelte';
	import { httpClients } from '#lib/api/clients.js';
	import { httpExternalProviders } from '#lib/api/external-providers.js';
	import { httpSamlProviders, httpSamlMetadata } from '#lib/api/saml-providers.js';
	import Button from '#lib/ui/primitives/Button.svelte';
	import LiveAddConnection from './LiveAddConnection.svelte';
	import LiveConnectionSettingsHarness from './LiveConnectionSettingsHarness.svelte';
	import UpstreamConnectionPage from './UpstreamConnectionPage.svelte';

	/** Story-only navigation; all reads and writes use the production HTTP clients and pages. */
	let {
		kind = 'sp',
		existing = false,
		canEdit = true,
		canPreview = true,
		canImport = true
	}: {
		kind?: 'sp' | 'idp';
		existing?: boolean;
		canEdit?: boolean;
		canPreview?: boolean;
		canImport?: boolean;
	} = $props();
	let opened = $state(untrack(() => existing));
	let created = $state(untrack(() => existing));
</script>

{#if opened}
	{#if kind === 'sp'}
		<LiveConnectionSettingsHarness
			kind="sp"
			clients={httpClients}
			saml={httpSamlProviders}
			metadata={httpSamlMetadata}
			{canEdit}
			canPreviewMetadata={canPreview}
			canImportMetadata={canImport}
			onback={() => (opened = false)}
		/>
	{:else}
		<UpstreamConnectionPage
			kind="idp"
			id="portal"
			externalProviders={httpExternalProviders}
			samlProviders={httpSamlProviders}
			metadata={httpSamlMetadata}
			canRead
			{canEdit}
			canPreviewMetadata={canPreview}
			canImportMetadata={canImport}
			onback={() => (opened = false)}
		/>
	{/if}
{:else if created}
	<Button onclick={() => (opened = true)}>Reopen connection</Button>
{:else}
	<LiveAddConnection
		resources={{
			clients: httpClients,
			samlProviders: httpSamlProviders,
			samlIdentityProviders: httpSamlProviders,
			previewMetadata: httpSamlMetadata.preview,
			canCreate: (candidate) => candidate === kind
		}}
		onnavigate={() => {
			created = true;
			opened = true;
		}}
	/>
{/if}
