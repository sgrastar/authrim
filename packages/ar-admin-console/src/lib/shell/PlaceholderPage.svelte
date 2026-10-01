<script lang="ts">
	import { hasMessage, t } from '$lib/i18n/i18n.svelte';
	import Callout from '$lib/ui/patterns/Callout.svelte';
	import Card from '$lib/ui/patterns/Card.svelte';
	import EmptyState from '$lib/ui/patterns/EmptyState.svelte';
	import PageHeader from '$lib/ui/patterns/PageHeader.svelte';
	import RetireNote from '$lib/ui/patterns/RetireNote.svelte';
	import ScopeNote from '$lib/ui/patterns/ScopeNote.svelte';
	import Page from '$lib/ui/templates/Page.svelte';
	import type { NavLocation } from './nav';

	/**
	 * Stand-in for an item whose page has not been rebuilt yet. It keeps the information
	 * architecture reviewable in a real environment: what the item is, how it behaves in the
	 * current scope, and which legacy Admin UI pages it will take over.
	 */
	interface Props {
		location: NavLocation;
	}

	let { location }: Props = $props();

	const item = $derived(location.item);
	const title = $derived(t(item?.label ?? location.area.label));
	const treatment = $derived(
		location.kind === 'platform' && location.top.inherited ? (item?.platform ?? 'inherit') : null
	);
	const assigned = $derived(item?.legacyRoutes ?? location.area.legacyRoutes);
	// Entries starting with "(new)" are design notes for features with no legacy page.
	const legacy = $derived(assigned.filter((route) => route.startsWith('/')));
	const newOnly = $derived(legacy.length === 0 && assigned.length > 0);

	/** Retirement notes are stored as <prefix>.title / .desc / .N.t / .N.d / .foot. */
	const retire = $derived.by(() => {
		const prefix = item?.retire;
		if (!prefix) return null;
		const key = (suffix: string) => `${prefix}.${suffix}`;
		const text = (suffix: string) => {
			const k = key(suffix);
			return hasMessage(k) ? t(k) : '';
		};
		const items: Array<{ title: string; detail: string }> = [];
		for (let n = 1; hasMessage(key(`${n}.t`)); n++) {
			items.push({ title: text(`${n}.t`), detail: text(`${n}.d`) });
		}
		return { title: text('title'), description: text('desc'), items, footnote: text('foot') };
	});
</script>

<Page width={item?.wide ? 'wide' : 'standard'}>
	<PageHeader {title} />
	{#if treatment}
		<ScopeNote
			kind={treatment}
			title={t(`plat.${treatment}.title`)}
			body={t(`plat.${treatment}.body`)}
			pill={t(`plat.${treatment}.pill`)}
		/>
	{/if}
	{#if retire}
		<RetireNote {...retire} />
	{/if}
	<Card>
		<EmptyState icon="stack" title={t('placeholder.title')} description={t('placeholder.body')} />
	</Card>
	{#if newOnly}
		<Callout>{t('placeholder.new')}</Callout>
	{:else if legacy.length > 0}
		<Card title={t('placeholder.legacy')} level={2}>
			<ul class="routes">
				{#each legacy as route (route)}
					<li><code>{route}</code></li>
				{/each}
			</ul>
		</Card>
	{/if}
</Page>

<style>
	.routes {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--fs-caption);
		color: var(--text-secondary);
		unicode-bidi: isolate;
		direction: ltr;
	}
</style>
