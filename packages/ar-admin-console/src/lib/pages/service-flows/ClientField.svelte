<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { ApiError } from '#lib/api/api-error.js';
	import type { ClientOption } from '#lib/api/clients.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import { useFlowResources } from './flow-resources-context';

	/**
	 * One of the tenant's clients, chosen from a list rather than typed (`client`), one of the
	 * redirect URIs registered for the client chosen in another field (`redirect`), or one of its
	 * enabled SAML service providers (`saml`, by entity ID): the setting must match one exactly, so
	 * none is typed.
	 */
	interface Props {
		label: string;
		hint?: string;
		required?: boolean;
		mode: 'client' | 'redirect' | 'saml';
		/** For `redirect`: the id of the client whose redirect URIs are offered. */
		clientId?: string;
		value: string;
		onchange: (value: string) => void;
	}

	let { label, hint, required = false, mode, clientId = '', value, onchange }: Props = $props();

	const resources = useFlowResources();
	/** Its messages: the clients', or the SAML service providers'. */
	const words = $derived(mode === 'saml' ? 'af.saml' : 'af.client');
	/** `denied`: the admin may not read the clients; `failed`: anything else went wrong. */
	let phase = $state<'loading' | 'ready' | 'denied' | 'failed'>('loading');
	let clients = $state<ClientOption[]>([]);
	let gone = false;
	onDestroy(() => (gone = true));

	async function load() {
		phase = 'loading';
		try {
			const list =
				mode === 'saml'
					? (await resources.samlProviders.listServiceProviders())
							// A provider turned off is not signed in to.
							.filter((provider) => provider.enabled)
							.map((provider) => ({
								id: provider.entityId,
								name: provider.name,
								redirectUris: []
							}))
					: await resources.clients.list();
			if (gone) return;
			clients = list;
			phase = 'ready';
		} catch (error) {
			if (gone) return;
			phase =
				error instanceof ApiError && (error.status === 401 || error.status === 403)
					? 'denied'
					: 'failed';
		}
	}
	onMount(() => void load());

	const options = $derived.by(() => {
		const offered =
			mode !== 'redirect'
				? clients.map((client) => ({ value: client.id, label: `${client.name} (${client.id})` }))
				: (clients.find((client) => client.id === clientId)?.redirectUris ?? []).map((uri) => ({
						value: uri,
						label: uri
					}));
		// A value saved before (a client since removed, a URI no longer registered) stays shown.
		return value && !offered.some((option) => option.value === value)
			? [...offered, { value, label: value }]
			: offered;
	});
</script>

{#if phase === 'loading'}
	<LoadingState label={t('common.loading')} />
{:else if phase === 'denied'}
	<Callout tone="warning">{t(`${words}.denied`)}</Callout>
{:else if phase === 'failed'}
	<Callout tone="warning">
		{t(`${words}.loadFailed`)}
		<Button size="sm" onclick={load}>{t('common.retry')}</Button>
	</Callout>
{:else if mode !== 'redirect' && clients.length === 0 && !value}
	<!-- Read, and there is none: not an error, there is just nothing to choose yet. -->
	<Callout tone="info">{t(`${words}.none`)}</Callout>
{:else}
	<SelectRow
		{label}
		{required}
		{hint}
		placeholder={mode === 'redirect' && !clientId ? t('af.client.chooseFirst') : t('af.choose')}
		disabled={mode === 'redirect' && !clientId}
		{value}
		onchange={(next) => onchange(next)}
		{options}
	/>
{/if}
