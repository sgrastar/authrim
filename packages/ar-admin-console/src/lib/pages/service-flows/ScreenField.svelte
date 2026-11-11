<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { ScreenKind, ScreenListItem } from '#lib/api/screens.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import LoadingState from '#lib/ui/patterns/LoadingState.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import SelectRow from '#lib/ui/patterns/SelectRow.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import { useFlowResources } from './flow-resources-context';
	import ScreenPick from './ScreenPick.svelte';
	import { backLinksOf, screenExitsOf } from './screen-exits';
	import { offeredScreens, settledScreen } from './screen-fields';

	/**
	 * Choosing the screen a flow step shows, among the tenant's screens of the given kinds. A screen
	 * has many settings of its own, so none is made or changed here: a link leads to the screens
	 * page.
	 */
	interface Props {
		label: string;
		hint?: string;
		required?: boolean;
		screenKinds: readonly ScreenKind[];
		/** The key of the chosen screen (as the runtime's `screen_ref`); empty when none is. */
		value: string;
		onchange: (id: string) => void;
		/**
		 * Where each way out of the chosen screen leads (its submit, a skip, an exit of its own
		 * name): the screen only says what its buttons do, the flow where they go. Absent: not asked.
		 */
		routes?: {
			destinations: (exit: string) => { value: string; label: string }[];
			valueOf: (exit: string) => string;
			onchange: (exit: string, destination: string) => void;
		};
	}

	let { label, hint, required = false, screenKinds, value, onchange, routes }: Props = $props();

	const SCREENS_PAGE = '/admin/customization/screens';
	const { screens: client } = useFlowResources();
	let phase = $state<'loading' | 'ready' | 'failed'>('loading');
	let screens = $state<ScreenListItem[]>([]);
	let gone = false;
	onDestroy(() => (gone = true));

	async function load() {
		phase = 'loading';
		try {
			const list = await client.list();
			if (gone) return;
			screens = list.screens;
			phase = 'ready';
			// Just one to choose (a new tenant has its built-in sign-up screen): it is the one; a
			// chosen screen since removed is not kept.
			const settled = settledScreen(value, offeredScreens(list.screens, screenKinds));
			if (settled !== undefined) onchange(settled);
		} catch {
			if (!gone) phase = 'failed';
		}
	}
	onMount(() => void load());

	const offered = $derived(offeredScreens(screens, screenKinds).length > 0);
	const chosen = $derived(screens.find((screen) => screen.screen_key === value));
	const exits = $derived(chosen ? screenExitsOf(chosen.fields) : []);
	const backLinks = $derived(chosen ? backLinksOf(chosen.fields) : []);
</script>

{#if phase === 'loading'}
	<LoadingState label={t('common.loading')} />
{:else if phase === 'failed'}
	<Callout tone="warning">
		{t('af.screen.loadFailed')}
		<Button size="sm" onclick={load}>{t('common.retry')}</Button>
	</Callout>
{:else}
	<ScreenPick
		{label}
		{hint}
		{required}
		{screens}
		{screenKinds}
		{value}
		onchange={(id) => onchange(id)}
	/>
{/if}
{#if phase === 'ready' && !offered}
	<Callout tone="info">{t('af.screen.none')}</Callout>
{/if}
{#if routes && chosen}
	<section class="exits" aria-labelledby="exits-{chosen.id}">
		<h3 class="exits__title" id="exits-{chosen.id}">{t('af.exit.title')}</h3>
		<p class="exits__lead">{t('af.exit.lead')}</p>
		{#each exits as way (way.exit)}
			<SelectRow
				label={way.label}
				value={routes.valueOf(way.exit)}
				onchange={(destination) => routes.onchange(way.exit, destination)}
				options={routes.destinations(way.exit)}
			/>
		{/each}
		{#each backLinks as words, index (index)}
			<p class="exits__back">{t('af.exit.back', { label: words })}</p>
		{/each}
	</section>
{/if}
<div>
	<Link href={SCREENS_PAGE} standalone>{t('af.screen.open')}</Link>
</div>

<style>
	.exits {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
		min-width: 0;
	}

	.exits__title {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.exits__lead,
	.exits__back {
		margin: 0;
		color: var(--text-secondary);
	}
</style>
