<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { SessionProfile } from '#lib/api/session-profiles.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SessionProfileFields from '#lib/pages/authentication/SessionProfileFields.svelte';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import { useFlowResources } from './flow-resources-context';

	/**
	 * Choosing the session profile a flow makes its sessions with. The chosen profile is shown
	 * below, as it is: it is shared, so it is made and changed on the session profiles page.
	 */
	interface Props {
		label: string;
		hint?: string;
		required?: boolean;
		/** The id of the chosen profile; empty when none is. */
		value: string;
		onchange: (id: string) => void;
	}

	let { label, hint, required = false, value, onchange }: Props = $props();

	const { sessionProfiles: client } = useFlowResources();
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let profiles = $state<SessionProfile[]>([]);
	let gone = false;
	onDestroy(() => (gone = true));

	async function load() {
		phase = 'loading';
		try {
			const list = await client.list();
			if (gone) return;
			profiles = list;
			phase = 'ready';
		} catch {
			if (!gone) phase = 'failed';
		}
	}
	onMount(() => void load());

	const chosen = $derived(profiles.find((profile) => profile.id === value));
	// A platform profile is named as one (a native select cannot hold a badge).
	const options = $derived(
		profiles.map((profile) => ({
			value: profile.id,
			label:
				profile.layer?.scope === 'platform'
					? t('pl.optionPlatform', { name: profile.name })
					: profile.name
		}))
	);
	const PROFILES = '/admin/authentication/session-profiles';
</script>

{#if phase === 'loading'}
	<LoadingState label={t('common.loading')} />
{:else if phase === 'failed'}
	<Callout tone="warning">
		{t('sp.field.loadFailed')}
		<Button size="sm" onclick={load}>{t('common.retry')}</Button>
	</Callout>
{:else}
	<SelectRow
		{label}
		{required}
		{hint}
		placeholder={t('af.choose')}
		{value}
		onchange={(id) => onchange(id)}
		{options}
	/>
	{#if value && !chosen}
		<Callout tone="warning">{t('sp.field.missing')}</Callout>
	{/if}
	<div class="session-profile__links">
		{#if chosen}
			<Link href={`${PROFILES}/${encodeURIComponent(chosen.id)}`} standalone
				>{t('sp.field.open')}</Link
			>
		{/if}
		<Link href={PROFILES} standalone>{t('sp.field.manage')}</Link>
	</div>
	{#if chosen}
		<section class="session-profile" aria-label={chosen.name}>
			<SessionProfileFields values={chosen.values} canWrite={false} onchange={() => {}} />
		</section>
	{/if}
{/if}

<style>
	.session-profile__links {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-related);
	}

	.session-profile {
		display: flex;
		flex-direction: column;
		gap: var(--space-field);
	}
</style>
