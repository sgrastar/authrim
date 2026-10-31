<script lang="ts">
	import { hasMessage, t, type MessageKey } from '$lib/i18n/i18n.svelte';
	import type { EndpointGroup } from '$lib/api/tenant-info';
	import Card from '$lib/ui/patterns/Card.svelte';
	import CopyButton from '$lib/ui/primitives/CopyButton.svelte';
	import DetailItem from '$lib/ui/patterns/DetailItem.svelte';
	import DetailList from '$lib/ui/patterns/DetailList.svelte';
	import AddressValue from './AddressValue.svelte';

	/**
	 * The addresses the tenant gives to apps and partners, by protocol: each with what it is for
	 * and a copy button, and a link (in a new tab) for the ones a browser can open. A name this
	 * console has no words for is shown as the API names it.
	 */
	interface Props {
		groups: EndpointGroup[];
	}

	let { groups }: Props = $props();

	const nameOf = (group: string, id: string) => {
		const key = `tg.ep.${group}.${id}`;
		return hasMessage(key) ? t(key as MessageKey) : id;
	};
	const groupName = (group: string) => {
		const key = `tg.ep.group.${group}`;
		return hasMessage(key) ? t(key as MessageKey) : group;
	};
</script>

<section class="endpoints" aria-labelledby="tg-endpoints">
	<div class="endpoints__head">
		<h2 id="tg-endpoints">{t('tg.ep.title')}</h2>
		<p>{t('tg.ep.lead')}</p>
	</div>
	{#each groups as group (group.id)}
		<Card title={groupName(group.id)} level={3}>
			<DetailList ruled>
				{#each group.endpoints as endpoint (endpoint.id)}
					<DetailItem label={nameOf(group.id, endpoint.id)}>
						<AddressValue url={endpoint.url} openable={endpoint.openable} />
						{#snippet end()}
							<CopyButton
								variant="icon"
								text={endpoint.url}
								label={t('tg.copy', { name: nameOf(group.id, endpoint.id) })}
							/>
						{/snippet}
					</DetailItem>
				{/each}
			</DetailList>
		</Card>
	{/each}
</section>

<style>
	.endpoints {
		display: flex;
		flex-direction: column;
		gap: var(--space-section);
	}

	.endpoints__head h2 {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: var(--fw-semibold);
	}

	.endpoints__head p {
		margin: 4px 0 0;
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}
</style>
