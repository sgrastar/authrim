<script lang="ts">
	import { untrack } from 'svelte';
	import type { FederationSourcesClient } from '#lib/api/federation-sources.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import EntityPicker, { type PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
	import { MAX_EXCLUDED } from './federation-page-model';

	/**
	 * The entities set aside: everyone else in the federation takes part. They are searched by
	 * name or entity ID in the federation's own inventory (on the server, never all at once) and
	 * kept on a list that is saved with the rest of the page. An entity with a connection of its
	 * own is not affected: the explicit connection always wins.
	 */
	interface Props {
		sourceId: string;
		client: FederationSourcesClient;
		excluded: string[];
		disabled?: boolean;
	}
	let { sourceId, client, excluded = $bindable(), disabled = false }: Props = $props();

	const labels: Record<string, string> = {};
	const itemOf = (id: string): PickerItem => ({
		value: id,
		label: labels[id] ?? id,
		description: id in labels ? id : undefined
	});
	let items = $state<PickerItem[]>(untrack(() => excluded.map(itemOf)));

	// The picker's chips and the page's list follow each other; each side writes only on a difference.
	const same = (a: readonly string[], b: readonly string[]) =>
		a.length === b.length && a.every((value, index) => value === b[index]);
	$effect(() => {
		const ids = items.map((item) => item.value);
		if (
			!same(
				ids,
				untrack(() => excluded)
			)
		)
			excluded = ids;
	});
	$effect(() => {
		const ids = excluded;
		if (
			!same(
				ids,
				untrack(() => items.map((item) => item.value))
			)
		)
			items = ids.map((id) => itemOf(id));
	});

	async function search(query: string, signal: AbortSignal): Promise<PickerItem[]> {
		const page = await client.entities(sourceId, { q: query, limit: 20 }, signal);
		for (const entity of page.items)
			if (entity.displayName) labels[entity.entityId] = entity.displayName;
		return page.items.map((entity) => ({
			value: entity.entityId,
			label: entity.displayName ?? entity.entityId,
			description: entity.displayName ? entity.entityId : undefined
		}));
	}
</script>

<Card title={t('sf.fed.exceptions.title')} description={t('sf.fed.exceptions.description')}>
	<EntityPicker
		label={t('sf.fed.exceptions.label')}
		placeholder={t('sf.fed.exceptions.placeholder')}
		hint={t('sf.fed.exceptions.hint', { max: MAX_EXCLUDED })}
		max={MAX_EXCLUDED}
		{disabled}
		{search}
		bind:items
	/>
	{#if excluded.length === 0}<Callout tone="info">{t('sf.fed.exceptions.none')}</Callout>{/if}
</Card>
